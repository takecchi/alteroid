import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import {
  EXCHANGE_KIND_FAILURE_PREFIX,
  EXCHANGE_KIND_GAUGE_PREFIX,
  EXCHANGE_KIND_THINNING_PREFIX,
} from './exchange-kind.js';
import { JournalFoldWindow, foldedRunText } from './journal-fold.js';
import { codeSpan } from './markdown-span.js';
import type { ManagerRecord } from './manager.js';
import { quotaMarkOf, type QuotaMark } from './quota-stop-notice.js';
import { createRecentMap, type RecentMap } from './recent.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import type { SynthesizedNoticeLabel } from './synthesized-notice.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import {
  describeUsageNotice,
  limitRecoveryOf,
  mergeRateLimitFacts,
  rateLimitMemoryKey,
  usageTransitionOf,
  withRecoveryNote,
  type RateLimitFacts,
  type UsageLimitNotice,
} from './usage-limits.js';
import { type UsageRecordTicket, usageDate } from './usage.js';

/**
 * **配達の制限ではない。** 溢れて忘れた文言は次に届いたときにもう一度配られる（取りこぼす側ではなく配り直す側へ倒れる）。
 * 忘れたこと自体は `onForget` が日誌へ残す。
 */
const USAGE_NOTICE_MEMORY_LIMIT = 32;

/** **「観測した値」ではなく「配った事実」を持つ器である。** `string`（最後に見た文言）だった頃の壊れ方は {@link UsageReceiver} の `#usageNotices` の doc にある。 */
interface UsageNoticeMemory {
  /** `notice.text` そのもの（言い換える前の SDK の原文）。 */
  delivered: RecentMap<true>;
  /**
   * **次にこの種類を配る1本の本文へ必ず載せて 0 に戻す。** 受信箱しか見ていない読み手には日誌の行が見えないので、
   * 載せないと「畳んだ」という事実が観測から消える。
   */
  folded: number;
  /**
   * **集計専用で、畳みの判定には使わない**（畳み鍵は `(kind, text)`）。`folded` だけだと、同じ managerId が
   * 100 回当たったのか100本が1回ずつ当たったのか見分けがつかない。`folded` と同じタイミングで空へ戻す。
   */
  foldedManagers: Set<string>;
}

/**
 * `Pool` が口として渡すもの。欄は参照で渡す（ここで別に持たない）: `usageStopped` は `case 'usage_notice'` が同期で立てる印で、
 * 起こし直しの側（`UsageWake` など）が同じ参照を読む。`tokenIdentities` は呼ぶたびに引く（読み直さずに1回だけ引く所は本体に注釈がある）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
export interface UsageReceiverPorts {
  /** `usage` だけを読む。差し替わりうるので、欄ではなく入れ物の参照を受けて呼ぶたびに引く。 */
  stores: { readonly usage: Stores['usage'] };
  now: () => number;
  nowIso: () => string;
  tokenIdentities: ReadonlyMap<string, { tokenId: string; generation: number }>;
  usageStopped: Set<string>;
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  persist: (record: ManagerRecord) => Promise<void>;
  movedAwayFrom: (record: ManagerRecord, fromRunnerId: string) => boolean;
  observeForTokenRotation: (
    managerId: string,
    observation: Omit<TokenRotatorObservation, 'observedBy'>,
  ) => Promise<void>;
  rememberResetTimeSkew: (event: { managerId: string; notice: UsageLimitNotice }) => Promise<void>;
  queueSynthesizedNotice: (
    managerId: string,
    label: SynthesizedNoticeLabel,
    text: string,
    quotaMark?: QuotaMark,
  ) => void;
}

/**
 * 使用量を受け取る出来事（`usage`・`peer_usage`・`context_usage`・`usage_notice`・`rate_limit`）の受け側（`Pool` から切り出した。振る舞いは変えていない）。
 * 起こし直し・印の解除・回し手への判断は持たない（口で `Pool` へ戻る）。
 */
export class UsageReceiver {
  readonly #ports: UsageReceiverPorts;
  readonly #journalExchange: UsageReceiverPorts['journalExchange'];

  /**
   * **鍵は「トークンの身元 × 枠の種類」である**（{@link rateLimitMemoryKey}）。「アカウント単位だからマネージャーに紐づけない」
   * と鍵を `kind` だけにすると、トークンのプールの別々のアカウントの事実が同じ欄を踏み合う。
   * 同じトークンで走る委譲は何本在っても同じ欄を共有する。
   * **揮発する**（書き手は `onRateLimit` だけで、probe は書かない）ので、デーモンが入れ替わると
   * 「もうクローンへ知らせた」という記憶は消える。そこは塞いでいない（塞ぐなら台帳への写しが要る）。
   */
  readonly #rateLimits = new Map<string, RateLimitFacts>();
  /**
   * `lastManagerId` はこの壁の遷移を最後に `#journal` へ書いた managerId。同じ managerId の連打は「跨いだ」に数えない
   * （そちらは `#rateLimitJournalFoldFor` が間引く）。
   * **畳むたびに1行書かない**: 同じ壁に短い間隔で何度も当たる状況を「マネージャーの数」という軸で作り直してしまうので、
   * 次の遷移が定まった回に `folded` を1行にまとめて吐き出す。
   * 集計専用で、`usageTransitionOf` の判定にも配る本文にも使わない。
   */
  readonly #rateLimitCrossFold = new Map<string, { lastManagerId: string; folded: Set<string> }>();
  /**
   * 種類ごとの、もうクローンへ配った上限の文言と、配らずに畳んだ件数。
   * 「最後に見た文言」ではなく「配った文言の集合」を覚える: 文言が2通り交互に届くと（A→B→A→B）
   * 毎回「違う」と判定されて、クローンのターンが1本ずつ焼かれる。
   * 畳んだ分は黙って消さず、日誌へ1件ずつ残し、件数は次に配る本文に載せる（{@link UsageNoticeMemory.folded}）。
   */
  readonly #usageNotices = new Map<string, UsageNoticeMemory>();
  /**
   * 枠の遷移を日誌へ書くときの畳み込み（{@link JournalFoldWindow}）。受信箱の畳み
   * （`SynthesizedNoticeStreak`）とは別物で、日誌の行だけを畳み、配る側の判定は変えない。
   * managerId ごとに1本持つ: 窓を共有すると別の委譲の合図が交互に来て連なりが切れ、どちらも畳まれない。
   * 終端すれば `Pool#retire` が {@link UsageReceiver.flushJournalFoldFor} で畳み残しを吐き出してから外す。
   */
  readonly #rateLimitJournalFolds = new Map<string, JournalFoldWindow>();

  constructor(ports: UsageReceiverPorts) {
    this.#ports = ports;
    this.#journalExchange = ports.journalExchange;
  }

  /** 作業者の落ちの原文を鍵の枠と突き合わせる材料（`Pool#describeWorkerLimitKey`）。読むだけ。 */
  get rateLimits(): ReadonlyMap<string, RateLimitFacts> {
    return this.#rateLimits;
  }

  /**
   * 札は `Pool#onEvent` が最初の `await` より前に取り、外側の `finally` でも返す（理由は `UsageRecordOrder`、`usage.ts`）。
   * ここで返す3経路（移った後の古い runner・記録の失敗・成功）は `release` が冪等であることに依る。
   */
  async onUsage(
    event: Extract<RunnerEvent, { type: 'usage' }>,
    fromRunnerId: string,
    record: ManagerRecord,
    usageTicket: UsageRecordTicket | undefined,
  ): Promise<void> {
    // この case への到着をターン成功の証拠にしない: 枠に当たったターンも `subtype: 'success'` / `is_error: true` でここへ来る。`answered === true` のときだけ観測を渡し、欠けていたら渡さない。`observedBy` は `#observeForTokenRotation` が付ける。
    // 別の runner へ移った後に古い runner から届いた累積は台帳の基準へ畳まず、応答の観測も渡さない（現役の鍵の成功ではない）。番はここでも待つ。
    if (this.#ports.movedAwayFrom(record, fromRunnerId)) {
      try {
        await usageTicket?.turn();
        await this.#recordStaleRunnerUsage(event, fromRunnerId, record);
      } finally {
        usageTicket?.release();
      }
      return;
    }

    if (event.answered === true) {
      await this.#ports.observeForTokenRotation(event.managerId, { succeeded: true });
    }

    // ここで自分の番を待つ: 上の `await` の間に後から届いた usage が先に `record` へ着くと、小さい累積が後から届いて「数え直し」と読まれ過大に数える。
    await usageTicket?.turn();
    const at = new Date(this.#ports.now());
    // 1回だけ引いて使い回す: 2回引くと、間に回し手が `#tokenIdentities` を書き換えたとき「有無の判定」と「使う値」が別の世代を見る。
    const tokenIdentity = this.#ports.tokenIdentities.get(event.managerId);
    let fold;
    try {
      fold = await this.#ports.stores.usage.record({
        // モデル id で層を代用しない: クローンも既定で opus で走る。
        layer: 'manager',
        // 作業者（Task subagent）と compaction の分もここに混ざる（SDK の `modelUsage` が合算して降ろす）。作業者の 0 行を作らない（「使っていない」と読める）。
        site: 'session',
        managerId: event.managerId,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { sessionId: event.sessionId, models: event.models },
        accumulation: 'cumulative',
        runner: { id: fromRunnerId, superseded: false },
        // `#tokenIdentity?.()` を読み直さない: 回した後に届いた前のセッションぶんの消費が新しいトークンに付く。無いときは渡さない。
        ...(tokenIdentity === undefined ? {} : { tokenId: tokenIdentity.tokenId }),
      });
    } catch (error) {
      usageTicket?.release();
      // 台帳に積めないことで仕事は止めない。ただし黙って消さない。理由を本文に添える: 無いと後から原因を辿れない。
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] 消費を台帳へ記録できなかった（この分は集計に出ない）: ${reasonOf(error)}`,
      );
      return;
    }

    usageTicket?.release();

    // 増分が空の回は行を書かない: 取れない軸に0の行を作らない。その回の `contextUsage` も一緒に捨てる（独立の `context_usage` イベントが残す）。
    if (Object.keys(fold.delta).length > 0) {
      await this.#ports.journal({
        type: 'turn_usage',
        layer: 'manager',
        site: 'session',
        managerId: event.managerId,
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        models: fold.delta,
        ...(fold.reset === undefined
          ? {}
          : {
              reset: { fromCostUsd: fold.reset.fromCostUsd, toCostUsd: fold.reset.toCostUsd },
            }),
        ...(event.contextUsage === undefined ? {} : { contextUsage: event.contextUsage }),
      });
    }

    // 数え直しを黙って通さない: 累積が 0 に戻るのは正常だが、記録が無いと後から「なぜ集計が飛んでいるか」を誰も辿れない。
    if (fold.reset !== undefined) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] 消費の累積が数え直された` +
          `（$${fold.reset.fromCostUsd.toFixed(4)} → $${fold.reset.toCostUsd.toFixed(4)}）。` +
          'resume か /clear で SDK 側の累積が 0 から始まったため。記録済みの分は保持している。',
      );
    }
  }

  async onPeerUsage(event: Extract<RunnerEvent, { type: 'peer_usage' }>): Promise<void> {
    // トークンの身元（`#tokenIdentities`）は付けない: マネージャー本体のセッションの鍵で、peer が使った鍵とは限らない（取れない軸は埋めない）。
    const at = new Date(this.#ports.now());
    try {
      if (event.unmetered === true) {
        // 0 を積まず「取れなかった」として数える。
        await this.#ports.stores.usage.recordUnmetered({
          layer: 'manager',
          site: 'peer',
          managerId: event.managerId,
          date: usageDate(at),
          at: at.toISOString(),
          provider: event.provider,
        });
        return;
      }
      const fold = await this.#ports.stores.usage.record({
        layer: 'manager',
        site: 'peer',
        managerId: event.managerId,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: {
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          models: event.models,
        },
        accumulation: 'oneshot',
      });
      if (Object.keys(fold.delta).length > 0) {
        await this.#ports.journal({
          type: 'turn_usage',
          layer: 'manager',
          site: 'peer',
          managerId: event.managerId,
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          models: fold.delta,
        });
      }
    } catch (error) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] peer（${event.provider}）の消費を台帳へ記録できなかった（この分は集計に出ない）: ${reasonOf(error)}`,
      );
    }
  }

  async onContextUsage(event: Extract<RunnerEvent, { type: 'context_usage' }>): Promise<void> {
    // `turn_usage` とは独立に書く: 増分が無い回・失敗した回は `turn_usage` の行を書かないので、文脈占有だけを別の行として残す。
    await this.#ports.journal({
      type: 'context_usage',
      layer: 'manager',
      site: 'session',
      managerId: event.managerId,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      turnSucceeded: event.turnSucceeded,
      contextUsage: event.contextUsage,
    });
  }

  async onUsageNotice(
    event: Extract<RunnerEvent, { type: 'usage_notice' }>,
    record: ManagerRecord,
  ): Promise<void> {
    // `reached` だけで立てる: `transition` / `warning` はまだ動いており、`org_policy` は鍵を回しても直らず起こすと1ターン焼く。
    // `await` の手前で立てる（速さの都合ではない）: 同じターンの `usage_notice` と `report` は並行に走り、後ろに置くと `report` 側の下ろしが先に走って自力で終えた委譲に印が残り、回転のたびに要らない一言を投げる。
    // 畳み（下の `delivered`）より手前に置く: 後ろだと同じ文言で2本目が当たった回に印が立たない。
    if (event.notice.kind === 'reached') {
      this.#ports.usageStopped.add(event.managerId);
      // 台帳にも写す: `Set` はデーモンの作り直しで消え、入れ替わりを跨いだ委譲が二度と起こされない。代入は `Set.add` と同じ同期の位置に置く（`await` を挟むと並行の `report` に先を越され、片方だけ遅れて真になる窓ができる）。
      // 欄が既に立っていれば persist しない（通知は何度も届く）。書き込みの失敗で下を巻き添えにしない: 下の回し手への受け渡しが鍵を回す契機そのもので、投げると鍵が回らないまま全員が止まる。
      if (record.job.usageStoppedAt === undefined) {
        record.job.usageStoppedAt = this.#ports.nowIso();
        try {
          await this.#ports.persist(record);
        } catch (error) {
          noteDroppedRecord('枠で止まった印の永続化', `managerId=${event.managerId}`, error);
        }
      }
    }

    // `stopped` ガードを足さない: `usage_notice` / `rate_limit` が運ぶのはアカウント単位の枠の事実で、マネージャーを止めても消えない（他も同じ枠を使う）。畳むとクローンが知るべき情報を捨てる。
    // 同じ文言で受信箱を埋めない: 通知はターンごとに繰り返し届き、変わった1回が埋もれる。判定は文字列の一致ではなく「もう配ったか」（`#usageNotices` の doc）。
    // 回し手へは受信箱の畳み（下の `delivered`）より先に渡す: 後ろだと2本目のマネージャーが同じ文言で当たった回に回し手が呼ばれない。
    await this.#ports.observeForTokenRotation(event.managerId, { notice: event.notice });

    // 末尾の `notice.text`（SDK の文言そのまま）は `codeSpan()` で包まない: 包むと等幅になり「文章」ではなく「コード」として描かれる。SDK の prose の描き方は表示の方針の話で、ここは決める場所ではない。
    // 実例では化けなかったが、SDK が文言を変えたら測り直しが要る。`describeUsageNotice()` の定型文は変えず、`withRecoveryNote` は末尾に1行足すだけ。
    const text = withRecoveryNote(
      describeUsageNotice(event.notice),
      limitRecoveryOf(event.notice.text),
    );
    const memory = this.#usageNoticeMemoryOf(event.notice.kind);
    if (memory.delivered.has(event.notice.text)) {
      // 畳んだことを記録に残す: `return` だけだと、後から「なぜ1回しか届いていないのか」を誰も辿れない。
      memory.folded += 1;
      // 件数だけでは「何本の異なるマネージャーが当たっているか」に戻せないので集合も持つ。
      memory.foldedManagers.add(event.managerId);
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}[${event.managerId}] （配達済みの知らせなので受信箱へは回さない。` +
          `この種類で ${memory.folded} 件目）${text}`,
      );
      // 畳んだ回も計器は回す（配達しないだけで枠に当たった事実は同じ）。
      await this.#ports.rememberResetTimeSkew(event);
      return;
    }
    memory.delivered.set(event.notice.text, true);
    const folded = memory.folded;
    memory.folded = 0;
    const foldedManagers = memory.foldedManagers;
    memory.foldedManagers = new Set();
    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] ${text}`,
    );
    // 畳んだ件数を配る1本に必ず載せる: 受信箱しか見ていない読み手には日誌の行が見えず、「畳んだ」が観測から消える。
    this.#ports.queueSynthesizedNotice(
      event.managerId,
      'usage_notice',
      folded === 0
        ? text
        : `${text}\n（前にこの種類を知らせてから、配達済みの同じ文言を ` +
            `${folded} 件畳んでいる。そのうち ${foldedManagers.size} 本の異なる` +
            `マネージャーが当たっている。全件は日誌に残っている。）`,
      // 枠の印は `reached` / `transition` だけに付ける: `warning`（近づいている）と `org_policy`（待っても直らない）を「枠に当たって止まった」の束へ入れない（印が無ければ担当ごとに配る）。
      event.notice.kind === 'reached' || event.notice.kind === 'transition'
        ? quotaMarkOf(
            {
              text: event.notice.text,
              ...(event.notice.resetsAt === undefined ? {} : { resetsAt: event.notice.resetsAt }),
            },
            this.#ports.now(),
            { sdkText: event.notice.text },
          )
        : undefined,
    );
    // 計器は配達より後ろに置く: `usage_notice` と `report` は並行に走り、この handler に `await` を足すと配達の順が動く（手前に置くと合流窓が知らせと報告を1本に畳んだ）。読み取り専用の計器を配達の臨界路へ置かない。
    await this.#ports.rememberResetTimeSkew(event);
  }

  async onRateLimit(event: Extract<RunnerEvent, { type: 'rate_limit' }>): Promise<void> {
    // `stopped` ガードを足さない（`usage_notice` と同じ）: 運んでいるのはアカウント単位の枠の事実。
    // 届いた1件で丸ごと置き換えない（`mergeRateLimitFacts`）: `status` を運ばない観測が「もう `rejected` を知らせた」記憶を消し、次の同じ `rejected` が同文でもう一度配られる。
    // 覚える欄は「トークンの身元 × 枠の種類」で分ける: `kind` だけだと別アカウントの事実が踏み合う。身元はセッションを起こした瞬間のもの（`#tokenIdentities`）で、現役を読み直さない（回った直後に届いた前の鍵の観測が新しい鍵の欄へ入る）。
    const factsKind = event.facts.kind ?? '';
    const memoryKey = rateLimitMemoryKey(
      this.#ports.tokenIdentities.get(event.managerId)?.tokenId,
      factsKind,
    );
    const previous = this.#rateLimits.get(memoryKey);
    const transition = usageTransitionOf(previous, event.facts);
    const merged = mergeRateLimitFacts(previous, event.facts);
    this.#rateLimits.set(memoryKey, merged);

    // 回し手へは事実と遷移で渡し、通知の形へ仕立て直さない: `rejected` は「その枠が尽きた」であって「仕事が止まった」ではなく、`reached` にすると `overage_exhausted` の設定でも課金枠を使わずに回る。
    // 遷移の門（下の `if (transition === undefined) return;`）より手前で渡す: 門はクローンへ同じ知らせを配らないためのもので、遷移が立たない `rejected` の回の回し手の契機を門の後ろでは拾えない。
    // `statusNow` は重ねる前の生の1件から取る: 重ねた形の `status` はアカウントを跨いで残り、回した直後の健全な鍵でもう一度回る。判断はここではしない（`#observeForTokenRotation`）。
    if (transition !== undefined || event.facts.status === 'rejected') {
      await this.#ports.observeForTokenRotation(event.managerId, {
        facts: merged,
        ...(transition === undefined ? {} : { transition }),
        ...(event.facts.status === undefined ? {} : { statusNow: event.facts.status }),
      });
    }

    if (transition === undefined) {
      // 同じ managerId の連打は「跨いだ」に数えない（`#rateLimitJournalFoldFor` が別に間引く）。違う managerId のときだけ集合へ足し、`#journal` は次に遷移が定まった回にまとめて呼ぶ。
      const crossFold = this.#rateLimitCrossFold.get(memoryKey);
      if (crossFold !== undefined && crossFold.lastManagerId !== event.managerId) {
        crossFold.folded.add(event.managerId);
      }
      return;
    }

    // 畳むたびに書かず、遷移が定まったこの回にだけ束ねて書く: 日誌の肥大化をマネージャーの数という軸で作り直さない。溜まっていない回は1行も増やさない。
    const crossFold = this.#rateLimitCrossFold.get(memoryKey);
    if (crossFold !== undefined && crossFold.folded.size > 0) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] 同じ壁を跨いで畳んだ報告に、` +
          `${crossFold.folded.size} 本の異なるマネージャーが当たっている` +
          '（前回この壁の遷移を記録してから、いまの遷移までのあいだ）。',
      );
    }
    this.#rateLimitCrossFold.set(memoryKey, {
      lastManagerId: event.managerId,
      folded: new Set(),
    });

    // 瞬間だけを知らせる（状態を毎回流さない）。
    // SDK 由来の識別子（`kind` / `overageDisabledReason`、任意の字面を通す `z.string()`）は、いま化けていなくても素で埋め込まず受信箱では包む。フォールバックの `'枠'` は包まない（デーモン自身の言葉が SDK の値の顔をする）。日誌は包まない（Markdown で描かれる面ではない）。
    // 定型文を2回書き写すと片方だけ直る事故が起きるので、包み方を受け取って1本の組み立て関数にする。
    const build = (wrap: (s: string) => string): string => {
      const kind = event.facts.kind === undefined ? '枠' : wrap(event.facts.kind);
      const reason =
        event.facts.overageDisabledReason === undefined
          ? ''
          : `（課金枠が使えない理由: ${wrap(event.facts.overageDisabledReason)}）`;
      return transition === 'entered_overage'
        ? `枠を使い切って課金枠から引き始めた（${kind}）。**まだ動くが、この先で止まる。**${reason}`
        : `枠から追い返された（${kind}）。この枠ではもう通らない。${reason}`;
    };
    // 畳むのは日誌の行だけ（1件目は必ず書く）: 配る側へ文字列一致の畳み込みを重ねると、`usageTransitionOf` の状態ベースの判定を壊す（`isCrossWindowStreakEligible` の doc）。
    const journalText = `[${event.managerId}] ${build((s) => s)}`;
    const folded = this.#rateLimitJournalFoldFor(event.managerId).observe(
      journalText,
      journalText,
      this.#ports.now(),
    );
    if (folded.flush !== undefined) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(folded.flush)}`,
      );
    }
    if (folded.write) {
      await this.#journalExchange('inbound', `${EXCHANGE_KIND_GAUGE_PREFIX}${journalText}`);
    }
    // `rate_limit` は枠の事実そのもの（遷移が立った回だけここへ来る）: 印を付ける。リセット時刻は facts の構造化された値だけ。
    this.#ports.queueSynthesizedNotice(
      event.managerId,
      'rate_limit',
      build(codeSpan),
      quotaMarkOf(
        {
          ...(event.facts.resetsAt === undefined ? {} : { resetsAt: event.facts.resetsAt }),
          ...(event.facts.kind === undefined ? {} : { kind: event.facts.kind }),
        },
        this.#ports.now(),
        transition === 'entered_overage' ? { enteredOverage: true } : {},
      ),
    );
  }

  /**
   * 終端した委譲の畳み残しを吐き出してから外す（`Pool#retire`）。畳んだ2件目以降はまだ日誌のどこにも書かれておらず、黙って捨てると件数が失われる。
   * `#rateLimits`・`#rateLimitCrossFold`・`#usageNotices` は外さない（アカウント単位の事実で、委譲の寿命に従わない）。
   * `void` で投げる（`Pool#retire` は同期）。
   */
  retire(managerId: string): void {
    const foldedAtRetire = this.#rateLimitJournalFolds.get(managerId)?.flush();
    if (foldedAtRetire !== undefined) {
      void this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(foldedAtRetire)}`,
      );
    }
    this.#rateLimitJournalFolds.delete(managerId);
  }

  // `void` で投げる: 止める手を日誌の書き込みで待たせない（書けなければ `#journal` が跡を残す）。
  flushJournalFolds(): void {
    for (const fold of this.#rateLimitJournalFolds.values()) {
      const flushed = fold.flush();
      if (flushed === undefined) continue;
      void this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(flushed)}`,
      );
    }
    this.#rateLimitJournalFolds.clear();
  }

  // 控えはメモリに持たず台帳の store に置く: デーモンの再起動で消え、毎晩の反映のたびに窓が開く。
  // 台帳の基準（新しい runner の高さ）へ畳まない: 小さい基準に対する大きい累積が全量の数え直しになり二重計上する。
  // 差が取れないときは積まず、累積そのものを日誌に残す: 積めば過大、積まなければ取りこぼしの恐れがあり、どれだけ記録済みか言えない。
  async #recordStaleRunnerUsage(
    event: Extract<RunnerEvent, { type: 'usage' }>,
    fromRunnerId: string,
    record: ManagerRecord,
  ): Promise<void> {
    const note = async (text: string): Promise<void> => {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_GAUGE_PREFIX}[${event.managerId}] 移った後に ${fromRunnerId} から届いた消費の累積（いまの宛先は ${record.job.runnerId ?? '不明'}）: ${text}`,
      );
    };
    const at = new Date(this.#ports.now());
    let fold;
    try {
      fold = await this.#ports.stores.usage.record({
        layer: 'manager',
        site: 'session',
        managerId: event.managerId,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { sessionId: event.sessionId, models: event.models },
        accumulation: 'cumulative',
        runner: { id: fromRunnerId, superseded: true },
      });
    } catch (error) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] 移った後に届いた消費を台帳へ記録できなかった（この分は集計に出ない）: ${reasonOf(error)}`,
      );
      return;
    }
    const total = Object.values(event.models).reduce((sum, m) => sum + m.costUsd, 0);
    if (fold.skipped?.reason === 'unknown-runner') {
      await note(
        `この runner の前回の累積を台帳が覚えていないので、記録済みの分が分からず積まなかった（累積 $${total.toFixed(4)}）。`,
      );
    } else if (fold.skipped?.reason === 'decreased') {
      await note(
        `この runner の累積が前回（$${fold.skipped.fromCostUsd.toFixed(4)}）より減っていたので、積まなかった（累積 $${fold.skipped.toCostUsd.toFixed(4)}）。`,
      );
    }
  }

  #usageNoticeMemoryOf(kind: string): UsageNoticeMemory {
    const existing = this.#usageNotices.get(kind);
    if (existing !== undefined) return existing;
    const memory: UsageNoticeMemory = {
      delivered: createRecentMap<true>({
        limit: USAGE_NOTICE_MEMORY_LIMIT,
        onForget: (texts) => {
          void this.#journalExchange(
            'inbound',
            `${EXCHANGE_KIND_THINNING_PREFIX}配り終えた上限の文言の記憶（${kind}）が上限（${USAGE_NOTICE_MEMORY_LIMIT}通り）に` +
              `達したので、古い ${texts.length} 件を忘れた。この文言が次に届いたら` +
              'もう一度クローンへ配る。',
          );
        },
      }),
      folded: 0,
      foldedManagers: new Set(),
    };
    this.#usageNotices.set(kind, memory);
    return memory;
  }

  // 上限を持たない: 外す契機が `retire()` に在る。
  #rateLimitJournalFoldFor(managerId: string): JournalFoldWindow {
    const existing = this.#rateLimitJournalFolds.get(managerId);
    if (existing !== undefined) return existing;
    const created = new JournalFoldWindow();
    this.#rateLimitJournalFolds.set(managerId, created);
    return created;
  }
}
