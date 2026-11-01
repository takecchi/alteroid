import { noteDroppedRecord } from './dropped-record.js';
import type { ManagerRecord } from './manager.js';
import type { Job, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import type { AgentToken } from './token-pool.js';

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

export interface UsageWakeSweeperDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  /** 欄は `Pool` が持つ。同じ Map/Set の参照を受け取り、ここでは別の欄を作らない。 */
  usageStopped: ReadonlySet<string>;
  usageWakeOwed: Set<string>;
  usageWakeRetry: Map<string, { failures: number; nextAt: number }>;
  usageNudgeInFlight: ReadonlyMap<string, Promise<unknown>>;
  workerLimitStopped: ReadonlyMap<
    string,
    { readonly preRotationKey: boolean; readonly turnStartedAt: string | undefined }
  >;
  workerLimitWakeRetry: Map<string, { failures: number; nextAt: number }>;
  rotationFoldDueAt: Map<string, number>;
  tokenIdentities: ReadonlyMap<string, { tokenId: string; generation: number }>;
  stores: Pick<Stores, 'tokens'>;
  now: () => number;
  stopped: () => boolean;
  /** `Pool#load` を束ねたもの。async の皮で包まない（await の回数・順を変えない）。以下の Promise を返す口も同じ。 */
  load: (managerId: string) => Promise<ManagerRecord | null>;
  findJob: (managerId: string) => Promise<Job | undefined>;
  journal: (entry: JournalEntryInput) => Promise<void>;
  tokenIdentity: () => { tokenId: string; generation: number } | undefined;
  /** 配線されていなければ `undefined`（掃きは何もしない）。 */
  tokenAvailability:
    ((tokenId: string) => Promise<'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined>) | undefined;
  /** `Pool#nudgeForUsageRotation`（段2。ここへは移していない）。 */
  nudge: (
    managerId: string,
    options?: { readonly allowRunning?: boolean },
  ) => Promise<UsageNudgeOutcome>;
  /** `Pool#wakeForWorkerLimit`（段2）。 */
  wakeForWorkerLimit: (managerId: string, trigger: 'turn-ended' | 'rotation') => Promise<boolean>;
  /** `Pool#clearUsageStoppedMark`。 */
  clearUsageStoppedMark: (managerId: string) => Promise<void>;
}

/**
 * 枠で止まった担当の周回の掃き（起こし直しの掃きの側）。8本の欄（`#usageStopped` など）は `Pool` が持ち、
 * `#handleEvent` の同期区間で立てる設計のためここへは移さない。参照を受け取って読み書きするだけで、欄を二重に持たない。
 * 起こし直しの本体（`Pool#nudgeForUsageRotation` 系）は口で受け取る。
 */
export class UsageWakeSweeper {
  readonly #deps: UsageWakeSweeperDeps;

  constructor(deps: UsageWakeSweeperDeps) {
    this.#deps = deps;
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
        const outcome = await d.nudge(managerId, { allowRunning: true });
        // `skipped`（届かなかった）は印を残し、間隔を伸ばして次の周回以降に挑み直す。
        this.noteOutcome(managerId, outcome);
        if (outcome === 'nudged' || outcome === 'gone') {
          await d.clearUsageStoppedMark(managerId);
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
   * 起こし直しの本体（`Pool`）からも呼ばれる。
   */
  noteOutcome(managerId: string, outcome: UsageNudgeOutcome): void {
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
        const outcome = await d.nudge(managerId);
        // `skipped`（届かなかった）は印を残し、挑み直しの状態へ乗せる。以後は上の走査が間隔を置いて拾う。
        this.noteOutcome(managerId, outcome);
        if (outcome === 'nudged' || outcome === 'gone') {
          await d.clearUsageStoppedMark(managerId);
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
      if (await d.wakeForWorkerLimit(managerId, 'turn-ended')) {
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
}
