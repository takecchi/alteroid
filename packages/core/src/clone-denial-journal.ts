import type { AgentPermissionDenial } from './agent-events.js';
import type { AgentSubagentStopRecord } from './agent-hooks.js';
import { UNKNOWN_AGENT_TYPE, UNKNOWN_TOOL_NAME } from './clone-unknown-labels.js';
import {
  denialInputAbsence,
  denialInputShape,
  RecentDenialLog,
  type DeniedRecord,
  type RecentDenial,
} from './denial-shape.js';
import { EXCHANGE_KIND_DECISION_PREFIX, EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import type { PermissionModeName } from './permission-mode.js';
import { createRecentMap } from './recent.js';
import type { JournalEntryInput } from './schema.js';

/**
 * 拒否の記憶の上限。`CloneToolUseJournal`（`clone-tool-use-journal.ts`）の `#unparsedToolInputJournaled`（入力が読めず断られた tool_use の id）も同じ上限を使うので、ここから出す。
 */
export const DENIED_TOOL_USE_MEMORY_LIMIT = 512;

const RECENT_DENIAL_LIMIT = 32;

const ALLOWED_BY_GRANT_MEMORY_LIMIT = 512;

// コマンド本文を持たない: 覚える必要があるのは人間が承認済みの規則（`grant.rule`）とその行の id だけのため
export interface AllowedByGrantRecord {
  readonly grantId: string;
  readonly rule: string;
  readonly agentId?: string;
}

/**
 * `Clone` が協力者へ渡す口。
 * 口の戻りは Promise を直に返す（`(entry) => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、
 * `#apply`・`#applyTurnEnded` の `await this.#denials.noteDenial(…)` と SDK の SubagentStop の hook の時機が動く。
 */
export interface CloneDenialJournalPorts {
  /** `Clone` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
  /** `Clone` の `#permissionMode`。構築の途中でこの協力者を作る（field 初期化）ので、値ではなく読む関数にする（`#permissionMode` は constructor の中で入る） */
  permissionMode(): PermissionModeName;
}

/**
 * 拒否の記録（確認へ上がらずに止められた実行を日誌へ残す）を持つ協力者。
 * 状態は4本（拒否の記憶・直近の拒否・許可 DB に一致して allow した控え・注意書きを出した grant）で、すべてこの中だけで書く。
 * `Clone` の `#onPreToolUse` が控えを足し（`rememberAllowedByGrant`）、`#onPostToolUse` / `#onPostToolUseFailure` が決着で消す（`settleAllowedByGrant`）。
 */
export class CloneDenialJournal {
  readonly #ports: CloneDenialJournalPorts;

  // 無制限には覚えない: 長く走る1本のセッションでメモリが伸び続けるため。忘れたら `onForget` で日誌へ残す（忘れた id が `permission_denials` に再び載ると同じ拒否が二重に載る）
  readonly #deniedToolUses = createRecentMap<DeniedRecord>({
    limit: DENIED_TOOL_USE_MEMORY_LIMIT,
    onForget: (ids) => {
      void this.#journalSelf(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}二重書き込み防止のために覚えている拒否の記憶が上限` +
          `（${DENIED_TOOL_USE_MEMORY_LIMIT}件）に達したので、古い ${ids.length} 件を忘れた: ` +
          `${ids.join(', ')}。この tool_use_id の拒否が生の合図と result の両方から` +
          '再び届くと、同じ拒否がもう一度日誌に載る。',
      );
    },
  });
  readonly #recentDenials = new RecentDenialLog(RECENT_DENIAL_LIMIT);
  // 決着（`Clone` の `#onPostToolUse` / `#onPostToolUseFailure` が `settleAllowedByGrant`）で消す: その後は拒否が来ないため。上限で忘れた id への拒否は検出できず、`onForget` がその代償を日誌へ残す
  readonly #allowedByGrantToolUses = createRecentMap<AllowedByGrantRecord>({
    limit: ALLOWED_BY_GRANT_MEMORY_LIMIT,
    onForget: (ids) => {
      void this.#journalSelf(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}許可 DB の規則に一致して allow を返した記憶が上限` +
          `（${ALLOWED_BY_GRANT_MEMORY_LIMIT}件）に達したので、古い ${ids.length} 件を忘れた: ` +
          `${ids.join(', ')}。この tool_use_id への拒否が後から届いても、もう「hook の allow を` +
          '追い越した」とは検出できない。',
      );
    },
  });
  // 日誌の書き込みは毎回行い、間引くのは注意書きの文言だけにする。上限や永続化は持たせない: 忘れても実害は注意書きがもう一度載るだけのため
  readonly #grantFunneledWarnedOnce = new Set<string>();

  constructor(ports: CloneDenialJournalPorts) {
    this.#ports = ports;
  }

  /** 直近の拒否（`#toolContext` と `#runtimeFacts` が読む） */
  recentDenials(): readonly RecentDenial[] {
    return this.#recentDenials.list();
  }

  /** 人間が承認した許可に一致して `allow` を返した呼び出しを控える（`Clone` の `#onPreToolUse` から） */
  rememberAllowedByGrant(toolUseId: string, record: AllowedByGrantRecord): void {
    this.#allowedByGrantToolUses.set(toolUseId, record);
  }

  /** 決着した呼び出しを控えから忘れる（`Clone` の `#onPostToolUse` / `#onPostToolUseFailure` から）: `PreToolUse` は実行前にしか発火せず、成功した呼び出しに後から拒否は届かない */
  settleAllowedByGrant(toolUseId: string): void {
    this.#allowedByGrantToolUses.delete(toolUseId);
  }

  /**
   * `tool_use` としては記録しない: 拒否は道具を使ったのではなく、混ぜると `digest` の「自分で手を動かした回数」が使えていない回数まで数える。
   * 生の合図と `result.permission_denials` の両方から呼ばれるので、`tool_use_id` で二重書きを防ぐ。
   */
  async noteDenial(denial: AgentPermissionDenial, via: 'live' | 'result'): Promise<void> {
    const tool = denial.tool ?? UNKNOWN_TOOL_NAME;

    // 必ず SDK が付けてきた `tool_use_id` で引く: 下の代用値では無関係な一致が起きうる。引いたら消す（両方の合図から届いても検出は1回）
    if (typeof denial.toolUseId === 'string') {
      const funneled = this.#allowedByGrantToolUses.get(denial.toolUseId);
      if (funneled !== undefined) {
        this.#allowedByGrantToolUses.delete(denial.toolUseId);
        await this.#noteGrantFunneled(funneled, denial, via);
      }
    }

    // id が無ければ道具の名前で代用する: 取りこぼすより重複を許す
    const toolUseId = denial.toolUseId ?? `${tool}:${via}`;
    // 既に書いた1件でも、入力を持つ記録が後から来たら形だけ足す: 入力を持つのは `via: 'result'` だけで、`has` で弾くと何を実行しようとしたかが残らない
    const seen = this.#deniedToolUses.get(toolUseId);
    if (seen !== undefined) {
      if (seen.input || denial.input === undefined) return;
      this.#deniedToolUses.set(toolUseId, { input: true });
      this.#recentDenials.fillHeadWord(toolUseId, denial.input);
      const later = denialInputShape(denial.input);
      if (later !== undefined) {
        await this.#journalSelf(
          'inbound',
          `${EXCHANGE_KIND_DECISION_PREFIX}先に書いた ${tool} の拒否について、ターン終わりの記録（合図の出所: result）に` +
            `入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: ${later}`,
        );
      }
      return;
    }
    this.#deniedToolUses.set(toolUseId, { input: denial.input !== undefined });
    this.#recentDenials.remember(toolUseId, new Date().toISOString(), tool, denial);

    // 欠けているものは作り物を出さず行を省く
    const denialDetails = [
      denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
      denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
      denial.message === undefined ? undefined : `モデルへの拒否文: ${denial.message}`,
    ].filter((line): line is string => line !== undefined);
    const why = denialDetails.length > 0 ? `（${denialDetails.join(' / ')}）` : '';

    // 層は `agent_id` で見る: 分けないと「クローン自身の手が止まっている」と「作業者の手が止まっている」が潰れ、誤った層へ次の判断が向く。
    // `via: 'result'` には `agent_id` が原理的に無いので「クローン本体」と決めつけず、「どちらの層か不明」のまま出す。
    // `agent_type` は今のところ常に無い（`permission-denied.test.ts` が不在を固定）。作り物の型名を出さない。
    const agentId = denial.agentId;
    const agentType = denial.agentType;
    const actorLabel =
      via !== 'live'
        ? 'どちらの層か不明'
        : agentId === undefined
          ? 'クローン本体'
          : `作業者（${agentType ?? UNKNOWN_AGENT_TYPE}）`;

    await this.#journalSelf(
      'inbound',
      `${EXCHANGE_KIND_DECISION_PREFIX}${tool} の実行が、確認へ上がらずに止められた${why}。` +
        `止められたのは ${actorLabel} の手（合図の出所: ${via}）。` +
        // 入力は形だけ残し値は残さない: 道具の入力には鍵が入りうる（`denial-shape.ts`）
        `入力の形: ${denialInputShape(denial.input) ?? denialInputAbsence(via)}。` +
        `許可モードは ${this.#permissionMode} で、この層に確認を回す相手は居ない。`,
    );
  }

  /**
   * 原因は断定しない: 分類器へ回された／deny 規則が上書きした、のどちらかをここからは切り分けられないので、「効いていない可能性がある」とだけ言う。
   * 事実は検出のたびに書き、注意書きは grant ごとに初回だけ足す。コマンド本文は読まない（形は `noteDenial` が書く）。
   */
  async #noteGrantFunneled(
    funneled: AllowedByGrantRecord,
    denial: AgentPermissionDenial,
    via: 'live' | 'result',
  ): Promise<void> {
    const denialDetails = [
      denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
      denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
    ].filter((line): line is string => line !== undefined);
    const why = denialDetails.length > 0 ? `（${denialDetails.join(' / ')}）` : '';

    const firstTimeForGrant = !this.#grantFunneledWarnedOnce.has(funneled.grantId);
    if (firstTimeForGrant) this.#grantFunneledWarnedOnce.add(funneled.grantId);
    const guidance = firstTimeForGrant
      ? ' 考えられるのは、SDK が hook の allow を分類器へ回すようになったこと、' +
        'または deny 規則が hook の allow を上書きしたことである' +
        '（どちらかは、あるいは両方かは、ここからは切り分けられない）。' +
        'この許可は、いまは効いていない可能性がある。'
      : '';

    await this.#journalSelf(
      'inbound',
      `${EXCHANGE_KIND_DECISION_PREFIX}許可 DB の規則 ${funneled.rule}（grant ${funneled.grantId}）で ` +
        `PreToolUse が allow を返したのに、同じ呼び出し（合図の出所: ${via}）が拒否された${why}。` +
        guidance,
    );
  }

  /**
   * 決着も拒否も来ないまま作業者が `SubagentStop` を迎えた `#allowedByGrantToolUses` の控えを日誌へ残す。
   * 「追い越された」とは書かず「決着しなかった」とだけ言う: 分かるのは不在の事実だけで、実際の拒否を受け取ってはいないため。
   * `agentId` で絞る: 本体や別の作業者の控えを消費しないため。
   */
  async onSubagentStop(record: AgentSubagentStopRecord): Promise<void> {
    if (typeof record.agentId !== 'string') return;
    const agentId = record.agentId;

    for (const [toolUseId, funneled] of this.#allowedByGrantToolUses.entries()) {
      if (funneled.agentId !== agentId) continue;
      this.#allowedByGrantToolUses.delete(toolUseId);

      const firstTimeForGrant = !this.#grantFunneledWarnedOnce.has(funneled.grantId);
      if (firstTimeForGrant) this.#grantFunneledWarnedOnce.add(funneled.grantId);
      const guidance = firstTimeForGrant
        ? ' 「hook の allow を追い越した」とは断定しない——決着も拒否の記録も' +
          '無いまま作業者が終わった、という不在の事実だけがここでは分かる。' +
          'この許可は、いまは効いていない可能性がある。'
        : '';

      await this.#journalSelf(
        'inbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}許可 DB の規則 ${funneled.rule}（grant ${funneled.grantId}）で ` +
          `PreToolUse が allow を返した作業者（agentId: ${agentId}）の呼び出し` +
          `（tool_use_id: ${toolUseId}）が、実行の決着も拒否の記録も無いまま、` +
          `その作業者の SubagentStop を迎えた。決着しなかった。${guidance}`,
      );
    }
  }

  // `Clone` の `#permissionMode` と同じ名前で読む: 日誌の文面の式（`${this.#permissionMode}`）を移す前と一字も変えないため。値でなく口越しに読むのは、`Clone` の constructor の中で入る値だから
  get #permissionMode(): PermissionModeName {
    return this.#ports.permissionMode();
  }

  // `Clone` の `#journalSelf` と同じ形で置く（走査の試験は、この private な helper の呼び出しの字面を数える。口を直に呼ぶ字面だと拾わない）。
  // async にせず口の Promise をそのまま返す: `await` / `void` の呼び出し側のタイミングを変えない。
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  #journalSelf(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#ports.journal({ type: 'exchange', with: 'self', role, text });
  }
}
