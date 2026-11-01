import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_RECOVERY_PREFIX } from './exchange-kind.js';
import type { ManagerRecord, ManagerSendResult } from './manager.js';
import { usageRotationNudge, workerLimitNudge } from './manager-notices.js';
import type { Job, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import type { SynthesizedNoticeLabel } from './synthesized-notice.js';
import { matchNoticeResetAgainstPool, type NoticeResetMatch } from './token-reset-match.js';
import type { AgentToken } from './token-pool.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import {
  parseRateLimitMemoryKey,
  type RateLimitFacts,
  type UsageLimitNotice,
} from './usage-limits.js';
import { describeWorkerLimitKeyMatch, type RememberedWindow } from './worker-limit-key-match.js';

/** 枠の起こし直しの結果。`'joined'` は同じ担当の起こし直しが既に走っていて、重ねなかった回（#5205）。 */
export type UsageNudgeOutcome = 'nudged' | 'still-running' | 'gone' | 'skipped' | 'joined';

/** 起こし直しが届かなかった担当への挑み直しの間隔: 1分から倍々に、上限30分（#4850）。 */
const USAGE_WAKE_RETRY_BASE_MS = 60 * 1000;
const USAGE_WAKE_RETRY_MAX_MS = 30 * 60 * 1000;
/**
 * 作業者の落ちで手を止めた担当への、周回の掃きの挑み直しの間隔: 1分から倍々に、上限5分。
 * 担当の枠の落ちの挑み直し（上限30分）より短くする: 現役の鍵が `ready` と分かってから起こすので、同じ枠に当たって1ターン焼く心配が無いため。
 */
const WORKER_LIMIT_WAKE_RETRY_BASE_MS = 60 * 1000;
const WORKER_LIMIT_WAKE_RETRY_MAX_MS = 5 * 60 * 1000;

/** 起こし直しが `Pool#send` へ渡す届け方（`SendDelivery` の `mode === 'usage-rotation'` の形）。 */
export interface UsageRotationDelivery {
  mode: 'usage-rotation';
  onFoldNoticeDelivered: (backgroundTasks: number) => void;
}

export interface UsageWakeDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  /** 欄は `Pool` が持つ。同じ Map/Set の参照を受け取り、ここでは別の欄を作らない。 */
  usageStopped: Set<string>;
  usageWakeOwed: Set<string>;
  usageWakeRetry: Map<string, { failures: number; nextAt: number }>;
  usageNudgeInFlight: Map<string, Promise<unknown>>;
  workerLimitStopped: Map<
    string,
    { readonly preRotationKey: boolean; readonly turnStartedAt: string | undefined }
  >;
  workerLimitWakeRetry: Map<string, { failures: number; nextAt: number }>;
  rotationFoldDueAt: Map<string, number>;
  resetTimeSkewMatches: Map<string, NoticeResetMatch>;
  supersedePending: ReadonlyMap<string, symbol>;
  tokenIdentities: ReadonlyMap<string, { tokenId: string; generation: number }>;
  stores: Pick<Stores, 'tokens'>;
  now: () => number;
  stopped: () => boolean;
  /** `Pool#load` を束ねたもの。async の皮で包まない（await の回数・順を変えない）。以下の Promise を返す口も同じ。 */
  load: (managerId: string) => Promise<ManagerRecord | null>;
  findJob: (managerId: string) => Promise<Job | undefined>;
  persist: (record: ManagerRecord) => Promise<void>;
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  tokenIdentity: () => { tokenId: string; generation: number; fingerprint?: string } | undefined;
  /** 配線されていなければ `undefined`（掃きは何もしない）。 */
  tokenAvailability:
    | ((tokenId: string) => Promise<'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined>)
    | undefined;
  /** `Pool#send` の `{}`（options）を埋めた形。起こし直しは `manager_send` と同じ経路を通る。 */
  send: (
    managerId: string,
    message: string,
    delivery: UsageRotationDelivery,
  ) => Promise<ManagerSendResult>;
  queueSynthesizedNotice: (managerId: string, label: SynthesizedNoticeLabel, text: string) => void;
  /** 第3引数が `undefined` のとき `Pool` 側が自分の指紋を引く（既定値の動きを変えない）。 */
  observeForTokenRotation: (
    managerId: string,
    observation: Omit<TokenRotatorObservation, 'observedBy'>,
    heldFingerprint: string | undefined,
  ) => Promise<void>;
  sessionTokenFingerprintOf: (managerId: string) => string | undefined;
  /** `AutoFold#beforeWakes`。 */
  beforeWakes: (wakeIds: readonly string[]) => Promise<void>;
  /** `UsageReceiver#rateLimits`。受け側は後から作るので、呼ぶたびに引く。読むだけ。 */
  rateLimits: () => ReadonlyMap<string, RateLimitFacts>;
}

/**
 * 枠で止まった担当の起こし直し（周回の掃き・鍵の回転の起こし・作業者の落ちの起こし・印の解除）。
 * 欄（`#usageStopped` など）は `Pool` が持ち、`#handleEvent` の同期区間で立てる設計のためここへは移さない。
 * 参照を受け取って読み書きするだけで、欄を二重に持たない。
 */
export class UsageWake {
  readonly #deps: UsageWakeDeps;
  readonly #journalExchange: UsageWakeDeps['journalExchange'];

  constructor(deps: UsageWakeDeps) {
    this.#deps = deps;
    this.#journalExchange = deps.journalExchange;
  }

  async resumeStoppedByUsage(): Promise<string[]> {
    const d = this.#deps;
    if (d.stopped()) return [];
    // 印が立っていないものも借りに載せる: 古い鍵で走っていた委譲はこれから枠に落ちうるが、回転は既に終わっていて鍵の側からの契機は二度と来ない。台帳には降りない: 台帳にしか無い委譲は `restore()` が拾う。
    for (const [managerId, record] of d.records) {
      const status = record.job.status;
      if (status === 'running' || status === 'waiting_human') d.usageWakeOwed.add(managerId);
    }

    await d.beforeWakes([...d.usageStopped, ...d.workerLimitStopped.keys()]);

    const nudged: string[] = [];
    for (const managerId of [...d.usageStopped]) {
      if (d.stopped()) break;
      if (await this.#wakeStoppedByUsage(managerId)) nudged.push(managerId);
    }
    // 現役の鍵で落ちた作業者の担当（#5030）。回転前の鍵で落ちた印は、鍵の回転が済んでいるのでここでは起こさない（ターンの終わりで起こす）。
    for (const managerId of [...d.workerLimitStopped.keys()]) {
      if (d.stopped()) break;
      if (await this.wakeForWorkerLimit(managerId, 'rotation')) nudged.push(managerId);
    }
    return nudged;
  }

  async settleStalled(): Promise<string[]> {
    const d = this.#deps;
    if (d.stopped()) return [];
    const nudged: string[] = [];
    // 挑み直しの状態があるのに像に無い委譲（再起動の後の done・failed・lost）は、台帳から像へ載せてから走査する（#4852）: 像だけを起点にすると拾われない
    for (const managerId of [...d.usageWakeRetry.keys()]) {
      if (d.records.has(managerId)) continue;
      const loaded = await d.load(managerId).catch(() => null);
      if (loaded === null) d.usageWakeRetry.delete(managerId);
    }
    // `#usageWakeOwed` ではなく `#records` を起点に走査する: 借りの managerId は `abort()` / `#retire()` で `#records` から先に消えうる。
    for (const [managerId, record] of [...d.records]) {
      if (d.stopped()) break;
      try {
        // 条件2: 枠で止まったことが分かっている（一般の停滞検知にしない門）。
        if (!d.usageStopped.has(managerId)) {
          d.usageWakeRetry.delete(managerId);
          continue;
        }
        // 条件3: `waiting_human` は含めない: 待っているのは枠ではなく人間の回答。
        if (record.job.status === 'waiting_human') continue;
        // 条件4: 「分からない」を症状へ倒さない（`turnEndedAt` が無ければ発火しない）。
        const turnEndedAfterLastReport = (): boolean => {
          if (record.turnEndedAt === undefined) return false;
          const turnEndedAt = Date.parse(record.turnEndedAt);
          if (Number.isNaN(turnEndedAt)) return false;
          if (record.job.lastReportAt !== undefined) {
            const lastReportAt = Date.parse(record.job.lastReportAt);
            if (Number.isNaN(lastReportAt)) return false;
            if (turnEndedAt <= lastReportAt) return false;
          }
          return true;
        };
        // 条件1: 借りが立っている（鍵が戻ったと回し手が言った時点でまだ走っていた）。
        const owedEligible =
          d.usageWakeOwed.has(managerId) &&
          record.job.status === 'running' &&
          turnEndedAfterLastReport();
        // 条件1b: 前の起こし直しが届かなかった担当は、借りが無くても間隔を置いて挑み直す（#4850 / #4733）。終わっている委譲も対象。走っている回は条件4を満たすときだけ。
        const retry = d.usageWakeRetry.get(managerId);
        const retryEligible =
          retry !== undefined &&
          d.now() >= retry.nextAt &&
          (record.job.status !== 'running' || turnEndedAfterLastReport());
        if (!owedEligible && !retryEligible) continue;

        // 借りは挑む前に下ろす: 同じ委譲を毎分掃き続けないため。
        d.usageWakeOwed.delete(managerId);
        const outcome = await this.#nudgeForUsageRotation(managerId, { allowRunning: true });
        // `skipped`（届かなかった）は印を残し、間隔を伸ばして次の周回以降に挑み直す。
        this.#noteOutcome(managerId, outcome);
        if (outcome === 'nudged' || outcome === 'gone') {
          await this.clearUsageStoppedMark(managerId);
        }
        if (outcome === 'nudged') nudged.push(managerId);
      } catch (error) {
        // 1件の失敗で残りを止めないが、黙って握らない: 起きないはずの例外が跡に残らないと、掃きが動いていない回と「対象が無かった」回が見分けられない。
        noteDroppedRecord('枠で止まった借りの清算', `managerId=${managerId}`, error);
      }
    }
    for (const managerId of await this.#sweepRetiredUsageWakes()) nudged.push(managerId);
    for (const managerId of await this.#sweepWorkerLimitWakes()) nudged.push(managerId);
    return nudged;
  }

  /**
   * 起こし直しの結果を、挑み直しの間隔へ写す（#4850）: 届かなかったら間隔を倍にして（1分・2分・4分…上限30分）次を決め、届いたら戻す。
   * 回数の上限は置かない（担当が枠で止まったまま黙るほうが高くつく）。間隔で、届かない状態が続いても日誌と runner を叩き続けない。
   */
  #noteOutcome(managerId: string, outcome: UsageNudgeOutcome): void {
    const d = this.#deps;
    // 重ねなかった回は数えない: 結果は1本目の呼び出し側が写す（#5205）
    if (outcome === 'joined') return;
    const foldDueAt = d.rotationFoldDueAt.get(managerId);
    d.rotationFoldDueAt.delete(managerId);
    if (outcome === 'skipped') {
      const failures = (d.usageWakeRetry.get(managerId)?.failures ?? 0) + 1;
      const interval = Math.min(
        USAGE_WAKE_RETRY_BASE_MS * 2 ** (failures - 1),
        USAGE_WAKE_RETRY_MAX_MS,
      );
      const backoffAt = d.now() + interval;
      // 背景処理を待たせている回は、待ちの上限の時刻より後へ延ばさない（#5044）。最短でも1分は空ける
      const nextAt =
        foldDueAt === undefined
          ? backoffAt
          : Math.min(backoffAt, Math.max(foldDueAt, d.now() + USAGE_WAKE_RETRY_BASE_MS));
      d.usageWakeRetry.set(managerId, { failures, nextAt });
    } else if (outcome !== 'still-running') {
      d.usageWakeRetry.delete(managerId);
    }
  }

  /**
   * 動いているデーモンの上で枠に当たって failed / lost になり、`#retire` で像から外れた担当を、周回の掃きでも起こす（#5166）。
   * 上の走査は `#records` を起点にするので、像に無く挑み直しの状態も持たない担当は誰にも拾われない。
   * 鍵の出来事（`rotated` / `recovered` / `reopened`）が出ない戻り方では、契機は他に無い。
   * 起こすのは次の両方が成り立つときだけ（片方でも欠ければ印を残す）:
   * (a) 現役の鍵が `ready`（`#wakeIfHeldTokenStale` と同じ口。通らないなら起こしても同じ枠に当たる）。
   * (b) 担当が止まった後に鍵が通る状態へ戻ったと言える。次の3つの材料のどれかが成り立つとき。材料が無ければ起こさない（「分からない」を起こす側へ倒さない）。
   *     1. 世代: 現役の世代が、担当の抱えていた世代（`#tokenIdentities`）と違う。
   *     2. 冷却明け: 現役の鍵の `cooldownUntil` が `usageStoppedAt` より後で、もう過ぎている。
   *     3. 成功の観測: 現役の鍵の行に `lastRejectedAt` も `cooldownUntil` も無く、`updatedAt` が `usageStoppedAt` より後。
   *        鍵が尽きて同じ世代へ戻る形では、成功を観測した回し手が `markTokenUsable` で 2 を消すので、2 だけでは拾えない。
   *        `lastRejectedAt` を消すのは `markTokenUsable` だけだが、`updatedAt` は人の編集（ラベル・順位・無効の切り替え・値の差し替え。
   *        `buildTokens` の `changed`）でも進む。拒否の記録が無い行で、止まった後に人が編集した回は誤って起こしうる
   *        （起こして枠に当たれば、既存の挑み直しの間隔と印に戻る。ready は成り立っているので被害は 1 ターン）。
   * 人が止めた担当・後継の居る担当は `#nudgeForUsageRotation` の許可リストが `gone` と返す（ここでは緩めない）。
   * 同じ担当を二重に起こさないのは、掃きを直列のままにして `#resuming` の busy と `#nudge` の判定に任せるため。ここに専用の排他は足さない。
   */
  async #sweepRetiredUsageWakes(): Promise<string[]> {
    const d = this.#deps;
    const nudged: string[] = [];
    const candidates = [...d.usageStopped].filter(
      (managerId) => !d.records.has(managerId) && !d.usageWakeRetry.has(managerId),
    );
    if (candidates.length === 0) return nudged;
    const identity = d.tokenIdentity();
    if (identity === undefined || d.tokenAvailability === undefined) return nudged;
    const availability = await d.tokenAvailability(identity.tokenId).catch(() => undefined);
    if (availability !== 'ready') return nudged;
    // 現役の鍵の行は(b)の2つ目・3つ目の材料で、世代が違えば要らないので、要る担当が現れるまで読まない。1周で1度だけ読む。
    let activeRow: Pick<AgentToken, 'cooldownUntil' | 'lastRejectedAt' | 'updatedAt'> | undefined;
    let activeRowRead = false;
    const readActiveRow = async (): Promise<typeof activeRow> => {
      if (!activeRowRead) {
        activeRowRead = true;
        try {
          activeRow = (await d.stores.tokens.list()).find((token) => token.id === identity.tokenId);
        } catch (error) {
          noteDroppedRecord('枠で止まった担当の鍵の行の読み取り', identity.tokenId, error);
          activeRow = undefined;
        }
      }
      return activeRow;
    };
    for (const managerId of candidates) {
      if (d.stopped()) break;
      try {
        // 判定の間に別の契機が起こして印を下ろした・像に載せた担当は触らない。
        if (
          !d.usageStopped.has(managerId) ||
          d.records.has(managerId) ||
          d.usageWakeRetry.has(managerId)
        ) {
          continue;
        }
        // 像へは載せない（`#load` しない）: 起こさない担当まで毎周 `#records` に居座らせないため。起こすなら `#nudgeForUsageRotation` が載せる。
        const job = await d.findJob(managerId);
        if (job === undefined) continue;
        const heldGeneration = d.tokenIdentities.get(managerId)?.generation;
        let returned = heldGeneration !== undefined && heldGeneration !== identity.generation;
        if (!returned && job.usageStoppedAt !== undefined) {
          const stoppedAt = Date.parse(job.usageStoppedAt);
          const row = await readActiveRow();
          if (!Number.isNaN(stoppedAt) && row !== undefined) {
            const until = row.cooldownUntil;
            const updatedAt = row.updatedAt === undefined ? NaN : Date.parse(row.updatedAt);
            returned =
              // 冷却明け: 止まった後に明けていて、もう過ぎている
              (until !== undefined && until > stoppedAt && until <= d.now()) ||
              // 成功の観測: 拒否も冷却も残っておらず、行が止まった後に更新されている（`markTokenUsable` だけが `lastRejectedAt` を消して `updatedAt` をその時刻にする）
              (until === undefined &&
                row.lastRejectedAt === undefined &&
                !Number.isNaN(updatedAt) &&
                updatedAt > stoppedAt);
          }
        }
        if (!returned) continue;
        // 判定の間に別の契機が起こして印を下ろしていたら、二重に起こさない。走っている間も同じ（#5205）
        if (!d.usageStopped.has(managerId) || d.usageNudgeInFlight.has(managerId)) continue;
        await d.journal({
          type: 'decision',
          decision: `[${managerId}] 枠で落ちて像から外れた担当を、掃きで起こし直す（現役の鍵は世代 ${String(identity.generation)}、ready。止まった後に通る状態へ戻った）`,
          grounds:
            `managerId=${managerId} tokenId=${identity.tokenId} 鍵の状態=ready ` +
            '（#5166。鍵の出来事が出ない戻り方では、像に無い担当を起こす契機が他に無い）',
        });
        const outcome = await this.#nudgeForUsageRotation(managerId);
        // `skipped`（届かなかった）は印を残し、挑み直しの状態へ乗せる。以後は上の走査が間隔を置いて拾う。
        this.#noteOutcome(managerId, outcome);
        if (outcome === 'nudged' || outcome === 'gone') {
          await this.clearUsageStoppedMark(managerId);
        }
        if (outcome === 'nudged') nudged.push(managerId);
      } catch (error) {
        noteDroppedRecord('像から外れた枠の停止の起こし直し', `managerId=${managerId}`, error);
      }
    }
    return nudged;
  }

  /**
   * 回転前の鍵で作業者が落ちて手を止めた担当を、周回の掃きでも起こす（#5030 の続き）。
   * ターンの終わり（`'turn-ended'`）に現役の鍵がまだ `ready` でなかった印や、起こしが届かなかった印は、今までは次の鍵の回転まで
   * 取り残された（回転が来なければ担当は止まったまま）。担当は `done` で手を止めて待っているので、起こしても仕事は失わない。
   * 判定は `'turn-ended'` と同じ（担当が `done`・現役の鍵が `ready`・同じターンのまま）。現役の鍵で落ちた印は拾わない:
   * その鍵は通らない見込みが高く、`ready` の判定にも作業者の落ちは入っていない（#4903）ので、起こすと同じ枠にまた当たる。
   * 起こせなかった回は、1分から倍々（上限5分）の間隔を空けて挑み直す。
   */
  async #sweepWorkerLimitWakes(): Promise<string[]> {
    const d = this.#deps;
    const nudged: string[] = [];
    for (const managerId of [...d.workerLimitWakeRetry.keys()]) {
      if (!d.workerLimitStopped.has(managerId)) d.workerLimitWakeRetry.delete(managerId);
    }
    for (const [managerId, mark] of [...d.workerLimitStopped]) {
      if (d.stopped()) break;
      if (!mark.preRotationKey) continue;
      const retry = d.workerLimitWakeRetry.get(managerId);
      if (retry !== undefined && d.now() < retry.nextAt) continue;
      if (await this.wakeForWorkerLimit(managerId, 'turn-ended')) {
        d.workerLimitWakeRetry.delete(managerId);
        nudged.push(managerId);
        continue;
      }
      if (!d.workerLimitStopped.has(managerId)) {
        d.workerLimitWakeRetry.delete(managerId);
        continue;
      }
      const failures = (retry?.failures ?? 0) + 1;
      const delayMs = Math.min(
        WORKER_LIMIT_WAKE_RETRY_BASE_MS * 2 ** (failures - 1),
        WORKER_LIMIT_WAKE_RETRY_MAX_MS,
      );
      d.workerLimitWakeRetry.set(managerId, { failures, nextAt: d.now() + delayMs });
    }
    return nudged;
  }

  /**
   * 枠の起こし直しを、担当ごとに1本だけ通す（#5205 の引き金）。走っている間に来た2本目は、自分では起こさず、1本目の終わりを待って `'joined'` を返す。
   * `'joined'` を受けた呼び出し側は、印・借り・挑み直しの状態に触らない: 後始末は1本目の呼び出し側が持つ。
   * 2本目の契機が持っていた理由（作業者の落ちなど）は、1本目の起こし直し（同じ担当への続きの一言）で満たされる。
   */
  async #nudgeForUsageRotation(
    managerId: string,
    options?: {
      readonly allowRunning?: boolean;
      // 作業者の落ちの印（#5030）から起こすとき: 専用の文を送り、日誌に理由を書き、クローンへの合成の知らせは積まない。
      readonly workerLimit?: { readonly generation: number | undefined };
    },
  ): Promise<UsageNudgeOutcome> {
    const d = this.#deps;
    const inFlight = d.usageNudgeInFlight.get(managerId);
    if (inFlight !== undefined) {
      await d.journal({
        type: 'decision',
        decision: `[${managerId}] 枠の起こし直しが既に走っているので、重ねて起こさない（終わるのを待つ）`,
        grounds:
          `managerId=${managerId}（#5205。2本目の起こし直しは、起こし直したばかりのセッションを古い鍵と見て畳み、` +
          '止めたセッションと新しいセッションを並べて走らせる元になった）',
      });
      await inFlight.catch(() => undefined);
      return 'joined';
    }
    const run = this.#nudgeForUsageRotationOnce(managerId, options);
    d.usageNudgeInFlight.set(managerId, run);
    try {
      return await run;
    } finally {
      if (d.usageNudgeInFlight.get(managerId) === run) d.usageNudgeInFlight.delete(managerId);
    }
  }

  /**
   * 印と借りは呼び出し側が下ろす: 呼び出し元によって下ろす条件が違う。
   * `'gone'`（台帳に居ない・`stopped`）は下ろしてよいが、`'skipped'`（届かなかった）は残す: 下ろすと次の鍵の回転でも二度と拾われない。
   * ホワイトリストで書く（`!== 'running' && …` の形にしない）: 状態が増えたとき既定が「起こす」＝1ターン焼く側へ倒れるのを避ける。
   * `allowRunning` が真でも `waiting_human` は通さない: 待っているのは枠ではなく人間の回答。
   * 投げない: 走査の途中で投げると、後ろに並んだ委譲が誰にも起こされないまま残る。
   */
  async #nudgeForUsageRotationOnce(
    managerId: string,
    options?: {
      readonly allowRunning?: boolean;
      readonly workerLimit?: { readonly generation: number | undefined };
    },
  ): Promise<'nudged' | 'still-running' | 'gone' | 'skipped'> {
    const d = this.#deps;
    try {
      const record = d.records.get(managerId) ?? (await d.load(managerId));
      if (record === null) return 'gone';
      // 後継へ引き継いだ前任は起こさない（#4861）: 枠の印が残っていても、二重に走らせない
      if (record.job.supersededBy !== undefined) return 'gone';
      // 後継を起こしている最中の前任も起こさない（#4865）: `supersededBy` を書くまでの間に鍵の回転が前任を起こして二重に走るため
      if (d.supersedePending.has(managerId)) return 'gone';
      const status = record.job.status;
      const allowRunning = options?.allowRunning === true;
      if (status === 'waiting_human') return 'still-running';
      if (status === 'running' && !allowRunning) return 'still-running';
      if (status !== 'running' && status !== 'done' && status !== 'failed' && status !== 'lost') {
        await d.journal({
          type: 'decision',
          decision:
            `[${managerId}] 認証トークンが通る状態へ戻ったが、この委譲は起こし直さない` +
            `（status=${status}）。`,
          grounds: '人間・クローンが止めた委譲を、鍵が戻ったことを理由に甦らせない。',
        });
        return 'gone';
      }
      // 新しい経路を作らず `send()` に相乗りする: どちらの道でも会話は続き、最初からやり直しにならない。
      // 抱えている古い鍵が使えないとき背景処理を理由に止めない（#4850）。`send()` ではなく `#send()` を使う: 人間・クローンの `manager_send` の振る舞い（預かり・15 分待ち）を変えないため
      let foldedBackgroundTasks = 0;
      const result = await d.send(
        managerId,
        options?.workerLimit === undefined
          ? usageRotationNudge()
          : workerLimitNudge(options.workerLimit.generation),
        {
          mode: 'usage-rotation',
          onFoldNoticeDelivered: (backgroundTasks) => {
            foldedBackgroundTasks = backgroundTasks;
          },
        },
      );
      if (result.outcome === 'delivered' || result.outcome === 'answered') {
        await this.#journalExchange(
          'outbound',
          `${EXCHANGE_KIND_RECOVERY_PREFIX}[${managerId}] 枠で止まっていた委譲を、通る鍵で続きから起こし直した` +
            (options?.workerLimit === undefined
              ? ''
              : `（理由: 作業者の落ち${options.workerLimit.generation === undefined ? '' : `, 現役の世代 ${String(options.workerLimit.generation)}`}）`) +
            `（status=${status}, outcome=${result.outcome}）`,
        );
        // failed / lost だけクローンへ知らせる（#4861）: 終わっていたはずの担当が起き上がるので、後継を立てていたなら二重になる。
        // done は生きていて続きを促しただけ（いつもの続き）なので積まない。作業者の落ちからの起こし直しは、文言が「枠で落ちていた」と食い違うので積まない（#5030）。
        if (options?.workerLimit === undefined && (status === 'failed' || status === 'lost')) {
          d.queueSynthesizedNotice(
            managerId,
            'usage_rewoken',
            `[${managerId}] を新しい鍵で起こし直した（枠で落ちていた。status=${status}）。` +
              '後継を立てていたなら、どちらかを manager_stop で止めること' +
              '（後継を立てるときは manager_start の supersedes に前任を渡すと、前任は起き上がらない）。',
          );
        }
        // 背景処理を畳んだ回は done でも知らせる（#4902）: 結果は届かないので担当が自分で確かめて進める。クローンは止まったと見誤りうる。peer だけを預けた回といつもの回転では積まない。
        // 担当が現役の鍵で戻っていれば、配る直前にクローンが畳む（`FOLD_WHEN_BACK_SYNTHESIZED_LABELS`。本文は日誌に残る）。戻りを確かめられなければ従来どおり届ける
        if (foldedBackgroundTasks > 0) {
          d.queueSynthesizedNotice(
            managerId,
            'usage_rewoken_folded',
            `[${managerId}] 鍵の入れ替えのため、背景処理 ${String(foldedBackgroundTasks)} 本を畳んで新しい鍵で起こし直し、` +
              '結果は届かないので自分で確かめて続きを進めるよう促した',
          );
        }
        return 'nudged';
      }
      await this.#journalExchange(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${managerId}] 認証トークンが通る状態へ戻ったので続きを促したが、届かなかった` +
          `（outcome=${result.outcome}）: ${result.detail}`,
      );
      return 'skipped';
    } catch (error) {
      await this.#journalExchange(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}[${managerId}] 認証トークンが通る状態へ戻ったので続きを促したが、落ちた: ` +
          reasonOf(error),
      );
      return 'skipped';
    }
  }

  /**
   * 枠（429）で落ちたと分かった委譲について、回し手へ「利用上限に当たった」と頼む（#4850）。
   * 使える鍵が在れば回し手が回して `resumeStoppedByUsage()` を呼び、新しい鍵で続きから起こし直される。無ければ、鍵が戻った時点の同じ呼び出しが拾う。
   * 新しい経路を作らず、`usage_notice` と同じ口（`#observeForTokenRotation`）に乗せる。投げない（口が握る）。
   */
  async requestRotationForFailure(
    managerId: string,
    text: string,
    heldFingerprint: string | undefined = this.#deps.sessionTokenFingerprintOf(managerId),
  ): Promise<void> {
    await this.#deps.observeForTokenRotation(
      managerId,
      { notice: { kind: 'reached', text } },
      heldFingerprint,
    );
    await this.wakeIfHeldTokenStale(managerId, heldFingerprint);
  }

  /**
   * 抱えていた鍵が回転で古くなった後に枠へ当たった担当を、回転の出来事を待たずにその場で起こし直す（#4980）。
   * 回し手は古い世代の観測を stale として ignored で返し、`reopenedTokenOf` が立たないので、次の回転まで誰も起こさない。
   * 現役の鍵がもう通る（`ready`）と分かっているときだけ起こす: 通らないなら起こしても同じ枠に当たる。
   * 回転の出来事で既に起こされて印が下りていれば何もしない。投げない（判定に失敗したら起こさず、印を残す）。
   */
  async wakeIfHeldTokenStale(
    managerId: string,
    // 像を外した後（`closed` / `resume_failed` の枝）に呼ぶときは、外す前に控えた指紋を渡す: 像と一緒に引き取りの指紋が消えるため
    heldFingerprint: string | undefined = this.#deps.sessionTokenFingerprintOf(managerId),
  ): Promise<void> {
    const d = this.#deps;
    if (d.stopped() || !d.usageStopped.has(managerId)) return;
    const held = d.tokenIdentities.get(managerId)?.generation;
    const identity = d.tokenIdentity();
    if (identity === undefined) return;
    // 世代を覚えていない（再起動で引き取っただけの）セッションは、鍵の指紋で比べる（#4643 の畳みの判定と同じ）: 世代だけで比べると
    // 「分からない」で素通りし、回し手も古い指紋の観測を stale として無視するので、引き取りの借りを使い切った後は次の回転まで誰も起こさない
    const heldLabel =
      held !== undefined
        ? held < identity.generation
          ? `世代 ${String(held)}`
          : undefined
        : heldFingerprint !== undefined &&
            identity.fingerprint !== undefined &&
            heldFingerprint !== identity.fingerprint
          ? `再起動で引き取ったセッションの鍵。指紋 ${heldFingerprint} が現役と食い違う`
          : undefined;
    if (heldLabel === undefined) return;
    const active = identity.generation;
    if (d.tokenAvailability === undefined) return;
    const availability = await d.tokenAvailability(identity.tokenId).catch(() => undefined);
    if (availability !== 'ready') return;
    // 判定の間に回し手が起こして印を下ろしていたら、二重に起こさない。
    // 別の契機の起こし直しが走っている間も起こさない（#5205）: 失敗の報告と closed が続けて届くと、両方の枝がここへ来る
    if (!d.usageStopped.has(managerId) || d.usageNudgeInFlight.has(managerId)) return;
    await d.journal({
      type: 'decision',
      decision: `[${managerId}] 抱えていた古い鍵（${heldLabel}）で枠に当たったが、現役の鍵（世代 ${String(active)}）はもう通るので、回転の出来事を待たずに起こし直す`,
      grounds:
        `managerId=${managerId} tokenId=${identity.tokenId} 鍵の状態=ready ` +
        '（#4980。回し手は古い世代の観測を無視するので、待っても次の回転まで起こされない）',
    });
    await this.#wakeStoppedByUsage(managerId);
  }

  /**
   * 枠で止まった印の立つ担当1件を起こし直し、結果を挑み直しの状態と印へ写す（`resumeStoppedByUsage()` のループ1件分）。
   * 起こした（`nudged`）ときは true を返す。
   */
  async #wakeStoppedByUsage(managerId: string): Promise<boolean> {
    const outcome = await this.#nudgeForUsageRotation(managerId);
    this.#noteOutcome(managerId, outcome);
    // 重ねなかった回は印に触らない: 下ろすかどうかは、走っていた1本目の呼び出し側が結果を見て決める（#5205）
    if (outcome === 'still-running' || outcome === 'joined') return false;
    // `'skipped'`（届かなかった）の印を下ろさない: 空振りで印を失うと、次に拾われるには新しい `usage_notice` が要り、それにはその委譲自身が起きる必要があって、クローンが手で `manager_send` を打つまで戻らなくなる。
    // 拾い直しは周回の掃き（`settleStalledUsageWakes`）が間隔を伸ばして担う（#4850）。ここでは回数上限を置かない: 戻れない委譲は `resume_failed` で印ごと畳まれる。
    if (outcome === 'skipped') return false;
    await this.clearUsageStoppedMark(managerId);
    this.#deps.usageWakeOwed.delete(managerId);
    return outcome === 'nudged';
  }

  /**
   * 作業者の枠の落ちで手を止めた担当を、通る鍵で起こし直す（#5030）。起こすのは担当の続きだけで、鍵の回転は起こさない（#4903）。
   * `'turn-ended'`: 回転前の鍵で落ちた印を、担当のターンが `done` で終わった時点で起こす。現役の鍵が `ready` と分かっているときだけ（`wakeIfHeldTokenStale` と同じ: 通らないなら起こしても同じ枠に当たる）。
   * `'rotation'`: 印を、次の鍵の回転（`resumeStoppedByUsage`）で起こす。回転前の鍵で落ちてターンの終わりに起こせなかった印も含む。
   * 起こさない: 担当が新しいターンを始めている（印を下ろす）・`running` / `waiting_human`（印は残す）・後継あり / `stopped`（`#nudgeForUsageRotation` が `gone` と返す。印を下ろす）。
   * 印は起こす前に下ろす（二重に起こさない）。届かなかったときだけ戻す。投げない。
   */
  async wakeForWorkerLimit(
    managerId: string,
    trigger: 'turn-ended' | 'rotation',
  ): Promise<boolean> {
    const d = this.#deps;
    const mark = d.workerLimitStopped.get(managerId);
    if (mark === undefined || d.stopped()) return false;
    try {
      const record = d.records.get(managerId) ?? (await d.load(managerId));
      if (record === null || record.job.turnStartedAt !== mark.turnStartedAt) {
        // 担当は新しいターンを始めている（または台帳に居ない）: 落ちが記録されたターンではなくなった。
        if (d.workerLimitStopped.get(managerId) === mark)
          await this.#clearWorkerLimitMark(managerId);
        return false;
      }
      if (
        record.job.supersededBy !== undefined ||
        d.supersedePending.has(managerId) ||
        record.job.status === 'stopped'
      ) {
        await this.#clearWorkerLimitMark(managerId);
        return false;
      }
      if (trigger === 'turn-ended') {
        if (!mark.preRotationKey || record.job.status !== 'done') return false;
      } else if (record.job.status === 'running' || record.job.status === 'waiting_human') {
        // 回転の契機では回転前の鍵の印も起こす: ターンの終わりに現役が `ready` でなかった印は、ここで拾わないと次の自分のターンまで取り残されるため
        // 走っている間は起こさない（印は残す）: ターンが終われば次の回転が拾う。
        return false;
      }
      const identity = d.tokenIdentity();
      if (trigger === 'turn-ended') {
        if (identity === undefined || d.tokenAvailability === undefined) return false;
        const availability = await d.tokenAvailability(identity.tokenId).catch(() => undefined);
        if (availability !== 'ready') return false;
      }
      // 判定の間に別の経路が下ろした・差し替えたなら、二重に起こさない。
      if (d.workerLimitStopped.get(managerId) !== mark) return false;
      await this.#clearWorkerLimitMark(managerId);
      await d.journal({
        type: 'decision',
        decision:
          `[${managerId}] 作業者が上限で落ちた鍵は回ったので、担当を起こし直す` +
          (identity === undefined ? '' : `（現役の世代 ${String(identity.generation)}）`),
        grounds:
          `managerId=${managerId} 契機=${trigger === 'turn-ended' ? 'ターンの終わり（回転前の鍵で落ちた・現役の鍵は ready）' : `鍵の回転（${mark.preRotationKey ? '回転前の鍵' : '現役の鍵'}で落ちた）`} ` +
          '（#5030。鍵の回転は起こさず、担当の続きだけを促す）',
      });
      const outcome = await this.#nudgeForUsageRotation(managerId, {
        workerLimit: { generation: identity?.generation },
      });
      if (outcome === 'skipped' || outcome === 'still-running') {
        if (!d.workerLimitStopped.has(managerId)) {
          d.workerLimitStopped.set(managerId, mark);
          const current = d.records.get(managerId);
          if (current !== undefined) {
            current.job.workerLimitStopped = { ...mark };
            await d.persist(current);
          }
        }
        return false;
      }
      // `'joined'` は印を戻さない: 走っていた枠の起こし直しが、同じ担当へ続きを促している（#5205）
      return outcome === 'nudged';
    } catch (error) {
      noteDroppedRecord('作業者の落ちの起こし直し', `managerId=${managerId}`, error);
      return false;
    }
  }

  async settleUsageWake(managerId: string, stoppedByUsage: boolean): Promise<void> {
    const d = this.#deps;
    if (!d.usageWakeOwed.has(managerId)) return;
    // 枠で止まったのでなければ借りだけ下ろす: 自力で終えたターンへ一言を投げると、1ターン焼いたうえに会話へ嘘の文脈が入る。
    // 例外は「作業者の落ちが記録されたターン」だけで、ここではなく `wakeForWorkerLimit` が別の印（`#workerLimitStopped`）で起こす（#5030）。
    if (!stoppedByUsage) {
      d.usageWakeOwed.delete(managerId);
      return;
    }
    d.usageWakeOwed.delete(managerId);
    // 印は起こせたと分かってから下ろす: 起こす前に下ろすと、空振りで印が消えて次の鍵の回転でも拾われなくなる。
    const outcome = await this.#nudgeForUsageRotation(managerId);
    this.#noteOutcome(managerId, outcome);
    if (outcome === 'skipped' || outcome === 'still-running' || outcome === 'joined') return;
    await this.clearUsageStoppedMark(managerId);
  }

  /**
   * 材料は `Pool#tokenIdentity`（プロセス内記憶）ではなく `stores.tokens`（DB 正本）から読む: `tokenGeneration` が `undefined` の場面でも独立に判定できるようにするため。
   * 呼ぶ位置は `UsageReceiver#onUsageNotice` の最後: `await` を足すと並行に走る `report` との勝ち負けが変わり、配達の順が動く。読み取り専用の計器は配達の臨界路の後ろへ置く。
   * 失敗しても投げない: `undefined` は「世代ずれではない」ではなく「判定できなかった」。
   */
  async rememberResetTimeSkew(event: {
    managerId: string;
    notice: UsageLimitNotice;
  }): Promise<void> {
    const d = this.#deps;
    if (event.notice.kind !== 'reached') return;
    try {
      const [active, pool] = await Promise.all([
        d.stores.tokens.readActive(),
        d.stores.tokens.list(),
      ]);
      const match = matchNoticeResetAgainstPool(event.notice.text, active?.tokenId, pool, {
        at: d.now(),
      });
      if (match === undefined) {
        d.resetTimeSkewMatches.delete(event.managerId);
      } else {
        d.resetTimeSkewMatches.set(event.managerId, match);
      }
    } catch (error) {
      noteDroppedRecord('resets時刻の突き合わせ', `managerId=${event.managerId}`, error);
    }
  }

  /**
   * 作業者の落ちの原文を、鍵のプールの各鍵の枠と突き合わせた1行を返す（#5021、`worker-limit-key-match.ts`）。
   * 材料は DB 正本のプール（`stores.tokens`）と、`rate_limit` の観測の記憶（`UsageReceiver#rateLimits`。枠の種類はここにしか無い）。
   * 投げない: 読めなければ「読めなかった」と書いた行を返す（note の配達を巻き添えにしない）。例外の文言は載せない（鍵の値を含みうる）。
   */
  async describeWorkerLimitKey(raw: string): Promise<string> {
    const d = this.#deps;
    let pool: readonly AgentToken[] | undefined;
    let activeTokenId: string | null | undefined;
    try {
      pool = await d.stores.tokens.list();
      try {
        activeTokenId = (await d.stores.tokens.readActive())?.tokenId ?? null;
      } catch (error) {
        noteDroppedRecord('作業者の落ちの現役の読み取り', 'worker_limit_key', error);
      }
    } catch (error) {
      noteDroppedRecord('作業者の落ちの鍵のプールの読み取り', 'worker_limit_key', error);
      pool = undefined;
    }
    const windows: RememberedWindow[] = [];
    for (const [key, facts] of d.rateLimits()) {
      const parsed = parseRateLimitMemoryKey(key);
      if (parsed?.tokenId === undefined || facts.resetsAt === undefined) continue;
      windows.push({
        tokenId: parsed.tokenId,
        kind: facts.kind ?? parsed.kind,
        resetsAt: facts.resetsAt,
      });
    }
    return describeWorkerLimitKeyMatch({ raw, at: d.now(), pool, activeTokenId, windows });
  }

  /**
   * 作業者の落ちの印を、`Map` と台帳の写しの両方から下ろす（`clearUsageStoppedMark` と同じ形）。`Map` は await の前に同期で下ろす: 呼び出し元の「判定 → 下ろす」の間に別の経路が割り込まないように。
   * 投げない: 呼び出し元は起こし直しの途中で、ここで落ちると起こさないまま終わるため。
   */
  async #clearWorkerLimitMark(managerId: string): Promise<void> {
    const d = this.#deps;
    d.workerLimitStopped.delete(managerId);
    try {
      const record = d.records.get(managerId) ?? (await d.load(managerId));
      if (record === null || record.job.workerLimitStopped === undefined) return;
      delete record.job.workerLimitStopped;
      await d.persist(record);
    } catch (error) {
      noteDroppedRecord('作業者の落ちの印の解除', `managerId=${managerId}`, error);
    }
  }

  /**
   * `Set` と台帳の写しを1本で下ろす: 手書きで散らすと片方だけ消し忘れる食い違いが起きる。
   * `case 'report'` の自力完走の枝は呼ばない: 直後の `#persist(record)` に乗せて二重書きを避ける。
   * 投げない: 呼び出し元の後片付け（`#retire()` など）が走らないまま終わるため。
   */
  async clearUsageStoppedMark(managerId: string): Promise<void> {
    const d = this.#deps;
    d.usageStopped.delete(managerId);
    d.usageWakeRetry.delete(managerId);
    // `resetTimeSkewMatches` も同じ寿命で下ろす: 古い判定が次の当たりに貼り付かないように。
    d.resetTimeSkewMatches.delete(managerId);
    try {
      const record = d.records.get(managerId) ?? (await d.load(managerId));
      if (record === null) return;
      if (record.job.usageStoppedAt === undefined) return;
      delete record.job.usageStoppedAt;
      await d.persist(record);
    } catch (error) {
      noteDroppedRecord('枠で止まった印の解除', `managerId=${managerId}`, error);
    }
  }
}
