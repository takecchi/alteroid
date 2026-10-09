/**
 * 率（%）は出さない: 台帳には締切も総量も無く、委譲の `running` は「走らせた」であって
 * 「進んでいる」ではないので、分母が定まらない。
 * 取れないものは 0 にしない（未了0件の最古の `at`・中央値は `null`、見込みが立たなければ `unavailable`）。
 *
 * 見込みの判定順: 未了0件の `estimated(0)` → `ledger_younger_than_window` → `history_incomplete`
 * → `closed_too_few` → `not_converging` → `estimated`。
 * - 未了0件の 0 は消化速度に依らない事実なので、材料が欠けていても言える。
 * - 前の 2 つを `closed_too_few` より先にするのは、閉じた件数そのものが数え落とし・短い期間のものである
 *   ときに「件数が少ない」と言うと、材料が欠けているという原因を隠すため。
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
 * `running` / `waiting_human` は含めない: どちらもまだ続く可能性がある。
 * `switch` で書く: `jobStatusSchema` に値が増えたとき、黙って「非終端」側へ落ちて数え上げから消えないよう `tsc` で落とす。
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

/** 式を変えたらここも変える。 */
export const PROGRESS_FORECAST_METHOD = 'open / (closedInWindow / windowHours)';

/** 見込みに付ける但し書き。 */
export const PROGRESS_FORECAST_NOTICE =
  '推定であり約束ではない。窓の中の流入は式に入れていない（openedInWindow は並べて示すだけ）';

const HOUR_MS = 3_600_000;

/** 導出を core の中でやり直さない: 日誌（`exchange`）の全履歴という I/O の材料が要るが、この関数は I/O を持たないから。 */
export type ProgressCommitmentRow = Commitment & {
  respondedAt?: string | undefined;
  activeManagerIds?: readonly string[] | undefined;
};

export type ProgressCommitments = Omit<CommitmentList, 'entries'> & {
  entries: readonly ProgressCommitmentRow[];
};

export interface SummarizeProgressInput {
  commitments: ProgressCommitments;
  jobs: readonly Job[];
  /** 省略できない: 省略を 0 と読ませない。 */
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
   * `untouched` / `responded` / `notApplicable` は排他で、足すと `total` になる。
   * `delegated` は他と排他ではない（未着手のまま委譲が走っている行が在りうる）。
   */
  byState: {
    untouched: number;
    responded: number;
    delegated: number;
    notApplicable: number;
  };
  /**
   * `trimmedClosed` は backlog の数には効かない: 刈られるのは片付き行だけで、未了の数・内訳・齢は
   * 影響を受けない。効くのは窓の中の完了・引き受けの件数と見込み。
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
   * 見込みの判定順とは独立に計算する: `ledger_younger_than_window` が先に勝つ台帳でも、刈りがあれば真になる。
   * 引き受けも同じ条件で欠ける（片付き行の `at` は `closedAt` 以前で、刈りは古い `closedAt` から）。
   */
  mayBeUndercounted: boolean;
  /** 近似: `Job` に終端時刻の欄が無く、終端後に `updatedAt` が動けば窓の外の終端も数える。 */
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

/** `'running'` を直書きしない: {@link isRunningJobStatus} を通す。 */
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

/** 窓が作れないのに数を返すと全部 0 の「進捗なし」に化けるので、不正な `windowHours` / `now` は `RangeError`。 */
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
      // 未来の `at`（時計のずれ）は負の齢を作らず 0 にする。
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

  const historyIncomplete =
    commitments.trimmedClosed > 0 && (closedOldestMs === null || closedOldestMs >= fromMs);

  const throughput: ProgressThroughput = {
    commitmentsOpened: opened,
    commitmentsClosed: closed,
    mayBeUndercounted: historyIncomplete,
    delegationsEnded: { count: delegationsEnded, basis: 'updatedAt' },
  };

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
  } else if (historyIncomplete) {
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
