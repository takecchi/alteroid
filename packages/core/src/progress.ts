/**
 * 作業の進捗を、台帳（`Commitment`）と委譲（`Job`）の行を数え直して出す純関数
 * （Issue #2241 の着地の順 1）。
 *
 * ## 何を作り、何を作らないか
 *
 * ここが持つのは**画面・CLI・クローンの道具が読む集計の中身**だけである。
 * I/O を持たない。`now` は引数で受ける（この関数は時計を読まない）。
 * 行そのもの（本文）は出さない——一覧は既存の `/commitments` と `/managers` が持つ。
 *
 * **率（%）は出さない。** 台帳には締切も総量も無く、委譲の `running` は「走らせた」で
 * あって「進んでいる」ではない。分母が定まらない。
 *
 * ## 窓の境界（固定）
 *
 * 窓は `[from, to]`（両端を含む）。`to` は `now`、`from` は `now - windowHours`。
 * ある時刻 `t` が窓の中とは `from <= t <= to`。`now` より未来の時刻（時計のずれ）は
 * 窓の外として数えない。時刻は `Date.parse` で比べる（文字列の辞書順に頼らない）。
 *
 * ## 「取れない」を 0 にしない
 *
 * - 未了が0件のとき、最古の `at`・齢の中央値は `null`（0 ではない）
 * - 報告の無い走行は `withoutReport` に数え、`lastReportAt` の最古・最新には混ぜない
 * - 見込みが立てられないときは数を作らず `unavailable` と理由を返す
 *
 * ## 見込み（forecast）の判定順
 *
 * 1. 台帳が空でなく未了が0件 → `estimated`（`hoursToDrain: 0`）。**「材料から計算した
 *    0」**であり、消化速度に依らない事実（割る相手が要らない）なので、閉じた件数が
 *    足りなくても、台帳が窓より若くても、履歴が欠けていても 0 と言える。
 *    ただし `unreadable > 0` なら読めない行が未了かもしれないので、`basis.unreadable`
 *    でそう言う（`notice` は定数で unreadable に触れない。見込みは止めない。Issue 本文の決め）
 * 2. `ledger_younger_than_window` — 台帳の最古の `at` が `from` より新しい、または
 *    行が1つも無い。**窓の全体を台帳が覆っていない**ので、以降の件数は窓より短い期間の
 *    ものである
 * 3. `history_incomplete` — `trimmedClosed > 0` かつ残っている片付き行の最古の
 *    `closedAt` が `from` 以後（残りが1件も無いときも含む）。`trimmedClosed` は古い側から
 *    消えるので、残りの最古が窓より前なら窓の中は欠けていない
 * 4. `closed_too_few` — 窓の中で閉じた件数が {@link MIN_CLOSED_IN_WINDOW} 未満
 * 5. `not_converging` — 窓の中で `openedInWindow >= closedInWindow`
 * 6. `estimated` — `open / (closedInWindow / windowHours)`
 *
 * 2 と 3 を 4 より先にするのは、閉じた件数そのものが数え落とし・短い期間のものである
 * ときに「件数が少ない」と言うと、原因（材料が欠けている）を隠すため。
 */

import { isRunningJobStatus } from './job-status-running.js';
import {
  commitmentOriginSchema,
  type Commitment,
  type CommitmentOrigin,
  type Job,
  type JobStatus,
} from './schema.js';
import type { CommitmentList } from './store.js';

/**
 * 委譲（`Job`）のうち、いま「手が離れている」状態を「終端」と呼ぶ。
 *
 * **`running` / `waiting_human` は含めない**——どちらもまだ続く可能性がある
 * 状態である（`jobStatusSchema` の doc）。
 *
 * **`switch` を通して網羅性を型で強制する。** `jobStatusSchema` に値が増えた
 * とき、ここを直し忘れると `tsc` が落ちる——黙って「非終端」側へ落ちて
 * 数え上げから消える形を避ける。
 */
export function isTerminalJobStatus(status: JobStatus): boolean {
  switch (status) {
    case 'running':
    case 'waiting_human':
      return false;
    case 'done':
    case 'failed':
    case 'lost':
    case 'stopped':
      return true;
  }
}

/** 窓の中で閉じた件数がこれ未満なら、速度を名乗らない（`closed_too_few`）。 */
export const MIN_CLOSED_IN_WINDOW = 3;

/** 見込みの式の名前（`basis.method`）。式を変えたらここも変える。 */
export const PROGRESS_FORECAST_METHOD = 'open / (closedInWindow / windowHours)';

/** 見込みに付ける但し書き。 */
export const PROGRESS_FORECAST_NOTICE =
  '推定であり約束ではない。窓の中の流入は式に入れていない（openedInWindow は並べて示すだけ）';

const HOUR_MS = 3_600_000;

/**
 * 台帳の1行 + `GET /commitments` が行ごとに導く2つの値（Issue #1003）。
 *
 * daemon は `commitmentRespondedAt(entry, repliesByConversation)` と
 * `commitmentActiveDelegationIds(entry, activeManagersByConversation)`（どちらも
 * `schema.ts`）の結果を、`/commitments` の応答と**同じ欄名**で足して渡す。
 * 導出を core の中でやり直さないのは、日誌（`exchange`）の全履歴という I/O の材料が
 * 要るため（この関数は I/O を持たない）。
 */
export type ProgressCommitmentRow = Commitment & {
  respondedAt?: string | undefined;
  activeManagerIds?: readonly string[] | undefined;
};

/** 入力の台帳。`CommitmentStore.list({ includeClosed: true })` の戻り値の `entries` を導出値つきにしたもの。 */
export type ProgressCommitments = Omit<CommitmentList, 'entries'> & {
  entries: readonly ProgressCommitmentRow[];
};

export interface SummarizeProgressInput {
  commitments: ProgressCommitments;
  jobs: readonly Job[];
  /**
   * `jobs`（`JobStore.listJobs()`）が飛ばした、読めない委譲の行の数
   * （`JobStore.listUnreadableJobs()` の件数。issue #2345）。**省略できない**——
   * 省略を 0 と読ませない（取れないものを 0 にしない）。
   */
  unreadableJobs: number;
  now: Date;
  windowHours: number;
}

export interface ProgressWindow {
  hours: number;
  from: string;
  to: string;
}

export interface ProgressAgeBuckets {
  /** `< 1h` */
  under1h: number;
  /** `1h <= 齢 < 24h` */
  under24h: number;
  /** `24h <= 齢 < 7d` */
  under7d: number;
  /** `>= 7d` */
  over7d: number;
}

export interface ProgressBacklog {
  /** 未了（`closedAt` が無い）の総数。`unreadable` は含まない。 */
  total: number;
  /** `commitmentOriginSchema` の全値をキーに持つ。0 は「その origin の未了が無い」。 */
  byOrigin: Record<CommitmentOrigin, number>;
  age: {
    /** 未了の中で最古の `at`。未了が0件なら `null`。 */
    oldestAt: string | null;
    /** 未了の齢（`now - at`、時間）の中央値。未了が0件なら `null`。偶数件は中央2つの平均。 */
    medianHours: number | null;
    buckets: ProgressAgeBuckets;
  };
  /**
   * #1003 の区分。**`/commitments` と Web（`commitments.tsx` の `AnsweredStateBadge` /
   * `InProgressBadge`）の見せ方に揃える。**
   *
   * - `untouched` — `origin === 'human'` かつ `respondedAt` が無い（Web の「未着手」）
   * - `responded` — `origin === 'human'` かつ `respondedAt` が在る（「返答済み・未クローズ」）
   * - `delegated` — `origin === 'human'` かつ `activeManagerIds` が1件以上（「進行中（委譲あり）」）
   * - `notApplicable` — `origin !== 'human'`。返答済みの導出の対象外で、Web も印を出さない
   *
   * **`untouched` / `responded` / `notApplicable` は排他で、足すと `total` になる。
   * `delegated` は他と排他ではない**（未着手のまま委譲が走っている行が在りうる。
   * Web も2つのバッジを別に出す）。
   */
  byState: {
    untouched: number;
    responded: number;
    delegated: number;
    notApplicable: number;
  };
  /**
   * 0 でなければ上の数は欠けうる。`unreadable` / `trimmedClosed` は台帳の行、
   * `unreadableJobs` は委譲の行（issue #2345）——0 でなければ `byState.delegated`・
   * `inProgress` の各数・`throughput.delegationsEnded` は読めた委譲の分しか数えていない。
   */
  completeness: { unreadable: number; trimmedClosed: number; unreadableJobs: number };
}

export interface ProgressInProgress {
  /** {@link isRunningJobStatus} が真の委譲。 */
  running: number;
  /** `waiting_human`。 */
  awaitingHuman: number;
  lost: number;
  /** 走行中のうち、報告（`lastReportAt`）が1件でも在るものの最古・最新。無ければ `null`。 */
  lastReport: {
    oldestAt: string | null;
    newestAt: string | null;
    /** 報告が1件も無い走行の数。最古・最新には混ぜない。 */
    withoutReport: number;
  };
}

export interface ProgressThroughput {
  commitmentsOpened: number;
  commitmentsClosed: number;
  /**
   * 終端状態（{@link isTerminalJobStatus}）かつ `updatedAt` が窓の中の委譲。
   * **近似である**——`Job` に終端時刻の欄が無く、終端後に `updatedAt` が動けば
   * 窓の外の終端も数える。
   */
  delegationsEnded: { count: number; basis: 'updatedAt' };
}

export interface ProgressForecastBasis {
  open: number;
  closedInWindow: number;
  openedInWindow: number;
  windowHours: number;
  method: typeof PROGRESS_FORECAST_METHOD;
  /** 読めなかった行の数。0 でなければ画面は但し書きを出す。 */
  unreadable: number;
  /** `closed_too_few` の閾値（{@link MIN_CLOSED_IN_WINDOW}）。 */
  minClosedInWindow: number;
}

export type ProgressUnavailableReason =
  'closed_too_few' | 'ledger_younger_than_window' | 'history_incomplete';

export type ProgressForecast =
  | {
      state: 'estimated';
      hoursToDrain: number;
      basis: ProgressForecastBasis;
      notice: string;
    }
  | { state: 'not_converging'; basis: ProgressForecastBasis }
  | { state: 'unavailable'; reason: ProgressUnavailableReason; basis: ProgressForecastBasis };

export interface ProgressSummary {
  window: ProgressWindow;
  backlog: ProgressBacklog;
  inProgress: ProgressInProgress;
  throughput: ProgressThroughput;
  forecast: ProgressForecast;
}

function median(sortedAscending: readonly number[]): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  const hi = sortedAscending[mid];
  const lo = sortedAscending[mid - 1];
  if (hi === undefined) return null;
  if (n % 2 === 1) return hi;
  return lo === undefined ? hi : (lo + hi) / 2;
}

function emptyByOrigin(): Record<CommitmentOrigin, number> {
  const out = {} as Record<CommitmentOrigin, number>;
  for (const origin of commitmentOriginSchema.options) out[origin] = 0;
  return out;
}

/**
 * 委譲の状態を、数える束へ振り分ける。**「実行中」は {@link isRunningJobStatus} を通す**
 * （`'running'` を直書きしない）。それ以外は `switch` で網羅を型に強制する。
 */
function jobBucket(status: JobStatus): 'running' | 'awaitingHuman' | 'lost' | 'other' {
  if (isRunningJobStatus(status)) return 'running';
  switch (status) {
    case 'waiting_human':
      return 'awaitingHuman';
    case 'lost':
      return 'lost';
    case 'running':
    case 'done':
    case 'failed':
    case 'stopped':
      return 'other';
  }
}

/**
 * 台帳と委譲から進捗の集計を出す。
 *
 * @throws RangeError `windowHours` が有限の正数でないとき、`now` が不正な日時のとき
 *   （窓が作れないのに数を返すと、全部 0 の「進捗なし」に化ける）
 */
export function summarizeProgress(input: SummarizeProgressInput): ProgressSummary {
  const { commitments, jobs, unreadableJobs, now, windowHours } = input;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('summarizeProgress: now が不正な日時');
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new RangeError(
      `summarizeProgress: windowHours は有限の正数（受け取った値: ${windowHours}）`,
    );
  }
  const fromMs = nowMs - windowHours * HOUR_MS;
  const inWindow = (iso: string | undefined): boolean => {
    if (iso === undefined) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= fromMs && t <= nowMs;
  };

  // --- 台帳 ---
  const byOrigin = emptyByOrigin();
  const byState = { untouched: 0, responded: 0, delegated: 0, notApplicable: 0 };
  const buckets: ProgressAgeBuckets = { under1h: 0, under24h: 0, under7d: 0, over7d: 0 };
  const openAgesHours: number[] = [];
  let oldestOpenAt: { iso: string; ms: number } | null = null;
  let opened = 0;
  let closed = 0;
  let ledgerOldestMs: number | null = null;
  let closedOldestMs: number | null = null;
  let openTotal = 0;

  for (const entry of commitments.entries) {
    const atMs = Date.parse(entry.at);
    if (Number.isFinite(atMs) && (ledgerOldestMs === null || atMs < ledgerOldestMs)) {
      ledgerOldestMs = atMs;
    }
    if (inWindow(entry.at)) opened += 1;
    if (entry.closedAt !== undefined) {
      if (inWindow(entry.closedAt)) closed += 1;
      const closedMs = Date.parse(entry.closedAt);
      if (Number.isFinite(closedMs) && (closedOldestMs === null || closedMs < closedOldestMs)) {
        closedOldestMs = closedMs;
      }
      continue;
    }
    // 未了
    openTotal += 1;
    byOrigin[entry.origin] += 1;
    if (entry.origin !== 'human') {
      byState.notApplicable += 1;
    } else {
      if (entry.respondedAt !== undefined) byState.responded += 1;
      else byState.untouched += 1;
      if (entry.activeManagerIds !== undefined && entry.activeManagerIds.length > 0) {
        byState.delegated += 1;
      }
    }
    if (Number.isFinite(atMs)) {
      // 未来の `at`（時計のずれ）は齢 0 として扱う（負の齢を作らない）
      const ageHours = Math.max(0, nowMs - atMs) / HOUR_MS;
      openAgesHours.push(ageHours);
      if (ageHours < 1) buckets.under1h += 1;
      else if (ageHours < 24) buckets.under24h += 1;
      else if (ageHours < 24 * 7) buckets.under7d += 1;
      else buckets.over7d += 1;
      if (oldestOpenAt === null || atMs < oldestOpenAt.ms) {
        oldestOpenAt = { iso: entry.at, ms: atMs };
      }
    }
  }
  openAgesHours.sort((a, b) => a - b);

  const backlog: ProgressBacklog = {
    total: openTotal,
    byOrigin,
    age: {
      oldestAt: oldestOpenAt === null ? null : oldestOpenAt.iso,
      medianHours: median(openAgesHours),
      buckets,
    },
    byState,
    completeness: {
      unreadable: commitments.unreadable.length,
      trimmedClosed: commitments.trimmedClosed,
      unreadableJobs,
    },
  };

  // --- 委譲 ---
  let running = 0;
  let awaitingHuman = 0;
  let lost = 0;
  let withoutReport = 0;
  let reportOldest: { iso: string; ms: number } | null = null;
  let reportNewest: { iso: string; ms: number } | null = null;
  let delegationsEnded = 0;
  for (const job of jobs) {
    const bucket = jobBucket(job.status);
    if (bucket === 'running') {
      running += 1;
      const reportMs = job.lastReportAt === undefined ? NaN : Date.parse(job.lastReportAt);
      if (job.lastReportAt === undefined || !Number.isFinite(reportMs)) {
        withoutReport += 1;
      } else {
        if (reportOldest === null || reportMs < reportOldest.ms) {
          reportOldest = { iso: job.lastReportAt, ms: reportMs };
        }
        if (reportNewest === null || reportMs > reportNewest.ms) {
          reportNewest = { iso: job.lastReportAt, ms: reportMs };
        }
      }
    } else if (bucket === 'awaitingHuman') awaitingHuman += 1;
    else if (bucket === 'lost') lost += 1;
    if (isTerminalJobStatus(job.status) && inWindow(job.updatedAt)) delegationsEnded += 1;
  }

  const inProgress: ProgressInProgress = {
    running,
    awaitingHuman,
    lost,
    lastReport: {
      oldestAt: reportOldest === null ? null : reportOldest.iso,
      newestAt: reportNewest === null ? null : reportNewest.iso,
      withoutReport,
    },
  };

  const throughput: ProgressThroughput = {
    commitmentsOpened: opened,
    commitmentsClosed: closed,
    delegationsEnded: { count: delegationsEnded, basis: 'updatedAt' },
  };

  // --- 見込み ---
  const basis: ProgressForecastBasis = {
    open: openTotal,
    closedInWindow: closed,
    openedInWindow: opened,
    windowHours,
    method: PROGRESS_FORECAST_METHOD,
    unreadable: commitments.unreadable.length,
    minClosedInWindow: MIN_CLOSED_IN_WINDOW,
  };
  const unavailable = (reason: ProgressUnavailableReason): ProgressForecast => ({
    state: 'unavailable',
    reason,
    basis,
  });
  const estimated = (hoursToDrain: number): ProgressForecast => ({
    state: 'estimated',
    hoursToDrain,
    basis,
    notice: PROGRESS_FORECAST_NOTICE,
  });

  let forecast: ProgressForecast;
  if (commitments.entries.length > 0 && openTotal === 0) {
    forecast = estimated(0);
  } else if (ledgerOldestMs === null || ledgerOldestMs > fromMs) {
    forecast = unavailable('ledger_younger_than_window');
  } else if (
    commitments.trimmedClosed > 0 &&
    (closedOldestMs === null || closedOldestMs >= fromMs)
  ) {
    forecast = unavailable('history_incomplete');
  } else if (closed < MIN_CLOSED_IN_WINDOW) {
    forecast = unavailable('closed_too_few');
  } else if (opened >= closed) {
    forecast = { state: 'not_converging', basis };
  } else {
    forecast = estimated(openTotal / (closed / windowHours));
  }

  return {
    window: {
      hours: windowHours,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    },
    backlog,
    inProgress,
    throughput,
    forecast,
  };
}
