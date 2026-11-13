import type { AgentCloneSession } from './agent-clone-session.js';
import type { AgentTurnUsage } from './agent-events.js';
import type { AgentProvider } from './agent-ports.js';
import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { JournalEntry, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import {
  CLONE_ACTOR_ID,
  usageDate,
  type UsageFold,
  type UsageSite,
  type UsageSnapshot,
} from './usage.js';

// スキーマ側から引く（`clone.ts` と同じ引き方）: 二重に定義すると、どちらかを直し忘れたときに型は緑のまま日誌の形だけがずれるため
type TurnUsageEntry = Extract<JournalEntry, { type: 'turn_usage' }>;
type CompactionObservation = NonNullable<TurnUsageEntry['compactions']>[number];

/** `case 'turn_ended'` だけが渡す、ターンの境界で聞いた値。蒸留のサイドクエリは本セッションの外なので compaction を持たず、渡さない。文脈占有は `context_usage` の行に書くので、ここには載せない。 */
export interface TurnBoundary {
  compactions?: CompactionObservation[];
}

/**
 * `turn_usage` の1行を組み立てる（状態を読まない）。欄は値があるときだけ置く: 空の値を置くと「0 使った」「compaction が空だった」と読めるため。
 * 増分が空の回に行を書かない判定は呼び元（`CloneUsageLedger#recordUsage`）に残す。
 */
export function turnUsageEntry(input: {
  readonly site: UsageSite;
  readonly usage: AgentTurnUsage;
  readonly fold: UsageFold;
  readonly turnBoundary: TurnBoundary | undefined;
}): JournalEntryInput {
  const { site, usage, fold, turnBoundary } = input;
  return {
    type: 'turn_usage',
    layer: 'clone',
    site,
    managerId: CLONE_ACTOR_ID,
    ...(usage.sessionId === undefined ? {} : { sessionId: usage.sessionId }),
    models: fold.delta,
    ...(fold.reset === undefined
      ? {}
      : {
          reset: { fromCostUsd: fold.reset.fromCostUsd, toCostUsd: fold.reset.toCostUsd },
        }),
    ...(turnBoundary?.compactions === undefined || turnBoundary.compactions.length === 0
      ? {}
      : { compactions: turnBoundary.compactions }),
  };
}

/**
 * `Clone` が協力者へ渡す口。読むだけで、状態は書かない。
 * 値ではなく読む関数にする: この協力者は field 初期化で作り、`#stores`・`#provider`・`#sdkSession` は constructor の中で入る（呼ばれるまで読まない）。
 * 口の戻りは Promise を直に返す（`(entry) => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、
 * `#applyTurnEnded` の `finalizeStep('usage', …)` と `stop()` の畳む順の時機が動く。
 */
export interface CloneUsageLedgerPorts {
  /** `Clone` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
  /** `Clone` の `#stores.usage` */
  usage(): Stores['usage'];
  /** `Clone` の `#provider`（`capabilities.usage` と `id` を読む） */
  provider(): Pick<AgentProvider, 'id' | 'capabilities'>;
  /** `Clone` の `#sdkSession.query`（畳む直前の累積を読む口。セッションが無ければ null） */
  query(): AgentCloneSession | null;
  /** `Clone` の `#sdkSession.sessionTokenIdentity`。`#tokenIdentity?.()` を読み直さない（回した直後に届いた前のセッションぶんの消費が新しいトークンに付く） */
  sessionTokenIdentity(): { tokenId: string; generation: number } | undefined;
}

/**
 * 消費の台帳（クローンの消費を `usage` ストアへ積み、`turn_usage` の行を日誌へ残す）を持つ協力者。状態は持たない（読むだけ）。
 * 呼び元は `Clone` の `#applyTurnEnded`（`finalizeStep('usage', () => this.#usage.recordUsage(…))`）・`#distillFromTranscript`・`#read`・`stop()`。
 * メソッドは元の `Clone` のものと同じ `async` のまま移した（外側を包み直さない）: `await` の段を増やさないため。
 * 観測（`#observeDistillQuota`・`#observeContextUsage`・`#noteFirstTurnToolSearch`）は台帳ではないので `Clone` に残している。
 */
export class CloneUsageLedger {
  readonly #ports: CloneUsageLedgerPorts;

  constructor(ports: CloneUsageLedgerPorts) {
    this.#ports = ports;
  }

  /**
   * セッションを畳む直前に、累積を control channel から1回読んで台帳へ積む。
   * `result` を出さずに終わったターンは `usage` を持たず、セッションごと死ぬと末尾ぶんが二度と積まれないため。
   * `#query` を閉じる前に呼ぶ: 閉じた後の control channel からは何も取れない。
   * `turnBoundary` は渡さない: ここはターンの境界ではなく、文脈占有も compaction も持たない。
   */
  async flushSessionUsage(): Promise<void> {
    const session = this.#ports.query();
    const models = await (session === null ? undefined : session.sessionModelUsage());
    if (models === undefined) return;
    await this.recordUsage({ models }, 'session', 'cumulative');
  }

  /**
   * `result` に載っている消費を台帳へ積む。
   * モデル id で層を代用しない: `ALTEROID_CLONE_MODEL` でクローンもマネージャーと同じ opus で走り、台帳で同じ `model` に並ぶため。
   * 台帳に積めなくてもターンは止めないが、黙って消さない。
   */
  async recordUsage(
    usage: AgentTurnUsage | undefined,
    site: UsageSite,
    accumulation: 'cumulative' | 'oneshot',
    /** `case 'turn_ended'` だけが渡す。蒸留のサイドクエリは本セッションの外なので文脈占有も compaction も持たず、渡さない。 */
    turnBoundary?: TurnBoundary,
  ): Promise<void> {
    if (usage === undefined) {
      // 数えるのは `capabilities.usage === false` のときだけ: Claude の失敗した result も usage を持たないが、あれは無報告ではない。
      if (this.#ports.provider().capabilities.usage === false)
        await this.#recordUnmeteredTurn(site);
      return;
    }

    const snapshot: UsageSnapshot = usage;

    const at = new Date();
    try {
      const identity = this.#ports.sessionTokenIdentity();
      const fold = await this.#ports.usage().record({
        layer: 'clone',
        site,
        managerId: CLONE_ACTOR_ID,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot,
        accumulation,
        // `#tokenIdentity?.()` を読み直さない: 回した直後に届いた前のセッションぶんの消費が新しいトークンに付く。
        ...(identity === undefined ? {} : { tokenId: identity.tokenId }),
      });

      // 増分が空の回は行を書かない: 取れない軸に0の行を作らない。
      if (Object.keys(fold.delta).length > 0) {
        await this.#ports.journal(turnUsageEntry({ site, usage, fold, turnBoundary }));
      }

      // 数え直しは黙って通さない: 記録が無いと後から「なぜ集計が飛んでいるか」を誰も辿れない。
      if (fold.reset !== undefined) {
        await this.#journalSelf(
          'outbound',
          `${EXCHANGE_KIND_GAUGE_PREFIX}自分の消費の累積が数え直された（${fold.reset.fromCostUsd.toFixed(4)} → ` +
            `${fold.reset.toCostUsd.toFixed(4)}）。resume か /clear で SDK 側の累積が ` +
            '0 から始まったため。記録済みの分は保持している。',
        );
      }
    } catch (error) {
      // stderr と日誌の両方に残す: stderr は台帳の失敗を名指しする跡で、日誌に無いと「起きなかった」と読める。
      noteDroppedRecord('利用状況の台帳', `layer=clone site=${site}`, error);

      // 日誌にも1件残す。循環しない: `#journal` は失敗しても投げ返さず、別のストア（日誌）へ1回試すだけ。
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[site=${site}] 消費を台帳へ記録できなかった（この分は集計に出ない）: ${reasonOf(error)}`,
      );
    }
  }

  /**
   * 消費を報告しない provider のターンを台帳へ「取れなかった」として1回数える。**0 を積まない**
   * （`UsageStore.recordUnmetered`）。台帳に積めなくてもターンは止めず、跡は stderr に残す。
   */
  async #recordUnmeteredTurn(site: UsageSite): Promise<void> {
    const at = new Date();
    try {
      const identity = this.#ports.sessionTokenIdentity();
      await this.#ports.usage().recordUnmetered({
        layer: 'clone',
        site,
        managerId: CLONE_ACTOR_ID,
        date: usageDate(at),
        at: at.toISOString(),
        provider: this.#ports.provider().id,
        ...(identity === undefined ? {} : { tokenId: identity.tokenId }),
      });
    } catch (error) {
      noteDroppedRecord('利用状況の台帳（無報告のターン）', `layer=clone site=${site}`, error);
    }
  }

  // `Clone` の `#journalSelf` と同じ形で置く（走査の試験は、この private な helper の呼び出しの字面を数える。口を直に呼ぶ字面だと拾わない）。
  // async にせず口の Promise をそのまま返す: `await` の呼び出し側のタイミングを変えない。
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  #journalSelf(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#ports.journal({ type: 'exchange', with: 'self', role, text });
  }
}
