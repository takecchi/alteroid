import { describe, expect, it } from 'vitest';

import {
  isManagerAwaitingJudgement,
  isManagerInFlight,
  isManagerOutcomeUnobserved,
} from './digest.js';
import { isRunningJobStatus } from './job-status-running.js';
import type { ManagerSummary } from './manager.js';
import { isTerminalJobStatus } from './progress.js';
import { pruneRescueLedger, rescueStashRemovalDue, syncTerminalMark } from './rescue-cleanup.js';
import { jobStatusSchema } from './schema.js';
import type { JobStatus, LastRescue, Task } from './schema.js';
import { countManagerSituation } from './situation.js';
import { taskStatusForJob } from './task.js';
import { selectWaitingReplyTasks } from './waiting-task-reply-notice.js';

// 「委譲の状態（JobStatus）」を見る判定の、いまの端の振る舞いを固定する（現状の挙動を固定。まとめる PR で見直す）。
// 本番コードは変えない。判定どうしの食い違いも「いまはこう食い違う」として固定している。
// 未知の値（列挙に無い文字列）は型を外して渡す: 将来 JobStatus が増えたとき、判定ごとの倒れ先が割れていることを見えるようにするため。

const KNOWN = jobStatusSchema.options;
const UNKNOWN = 'bogus' as unknown as JobStatus;
const ALL: readonly JobStatus[] = [...KNOWN, UNKNOWN];

/** 値 → 結果 の表を作る。 */
function tableOf<T>(fn: (status: JobStatus) => T): Record<string, T> {
  return Object.fromEntries(ALL.map((status) => [status, fn(status)]));
}

describe('JobStatus の全値（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('列挙は 6 値', () => {
    expect([...KNOWN]).toEqual(['running', 'waiting_human', 'done', 'failed', 'lost', 'stopped']);
  });
});

describe('名前付きの判定 × 全値（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('digest.ts isManagerInFlight: running と waiting_human だけ。未知は false', () => {
    expect(tableOf(isManagerInFlight)).toEqual({
      running: true,
      waiting_human: true,
      done: false,
      failed: false,
      lost: false,
      stopped: false,
      bogus: false,
    });
  });

  it('digest.ts isManagerAwaitingJudgement: lost だけ。未知は false', () => {
    expect(tableOf(isManagerAwaitingJudgement)).toEqual({
      running: false,
      waiting_human: false,
      done: false,
      failed: false,
      lost: true,
      stopped: false,
      bogus: false,
    });
  });

  it('digest.ts isManagerOutcomeUnobserved: lost と failed。未知は false', () => {
    expect(tableOf(isManagerOutcomeUnobserved)).toEqual({
      running: false,
      waiting_human: false,
      done: false,
      failed: true,
      lost: true,
      stopped: false,
      bogus: false,
    });
  });

  it('job-status-running.ts isRunningJobStatus: running だけ（waiting_human は含めない）。未知は true', () => {
    expect(tableOf(isRunningJobStatus)).toEqual({
      running: true,
      waiting_human: false,
      done: false,
      failed: false,
      lost: false,
      stopped: false,
      bogus: true,
    });
  });

  it('progress.ts isTerminalJobStatus: done / failed / lost / stopped。未知は false ではなく undefined（default の無い switch が値を返さない）', () => {
    expect(tableOf(isTerminalJobStatus)).toEqual({
      running: false,
      waiting_human: false,
      done: true,
      failed: true,
      lost: true,
      stopped: true,
      bogus: undefined,
    });
  });

  it('task.ts taskStatusForJob: running / waiting_human は waiting、ほかは needs_decision。未知も needs_decision', () => {
    expect(tableOf(taskStatusForJob)).toEqual({
      running: 'waiting',
      waiting_human: 'waiting',
      done: 'needs_decision',
      failed: 'needs_decision',
      lost: 'needs_decision',
      stopped: 'needs_decision',
      bogus: 'needs_decision',
    });
  });
});

describe('インラインの綴りを、公開の関数を通して固定する（現状の挙動を固定。まとめる PR で見直す）', () => {
  const task = (id: string): Task => ({
    id,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    status: 'waiting',
    origin: 'human',
    title: id,
    body: id,
    originConversationId: 'conv-1',
  });

  it('waiting-task-reply-notice.ts selectWaitingReplyTasks（running / waiting_human を直書きで比べる）: 委譲が結び付いて「名乗らない」値', () => {
    const named = tableOf(
      (status) =>
        selectWaitingReplyTasks([task('t')], [{ status, taskId: 't' }], new Set(['conv-1']))
          .length === 0,
    );
    // true = 委譲が走っているとみなされ、返事待ちの行から外れる
    expect(named).toEqual({
      running: true,
      waiting_human: true,
      done: false,
      failed: false,
      lost: false,
      stopped: false,
      bogus: false,
    });
  });

  it('situation.ts countManagerSituation（running / waiting_human / done かつ live / isManagerAwaitingJudgement の連鎖）の区分', () => {
    const base = {
      managerId: 'm',
      live: true,
      cwd: '/work',
      request: 'r',
      startedAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
      waiting: [],
    };
    const bucketOf = (status: JobStatus, live: boolean): string => {
      const counts = countManagerSituation([{ ...base, status, live } as ManagerSummary]);
      const buckets = ['running', 'waitingHuman', 'idle', 'lost', 'other'] as const;
      return buckets.filter((name) => counts[name] === 1).join('+');
    };
    expect(Object.fromEntries(ALL.map((status) => [status, bucketOf(status, true)]))).toEqual({
      running: 'running',
      waiting_human: 'waitingHuman',
      done: 'idle',
      failed: 'other',
      lost: 'lost',
      stopped: 'other',
      bogus: 'other',
    });
    // done は live でなければ idle に入らず other（running / waiting_human / lost は live に関わらず同じ）
    expect(Object.fromEntries(ALL.map((status) => [status, bucketOf(status, false)]))).toEqual({
      running: 'running',
      waiting_human: 'waitingHuman',
      done: 'other',
      failed: 'other',
      lost: 'lost',
      stopped: 'other',
      bogus: 'other',
    });
  });

  describe('rescue-cleanup.ts（done / failed / stopped を直書きする isGraceStatus と、running / waiting_human を直書きする prune）', () => {
    const rescue = (terminalStatus?: 'done' | 'failed' | 'stopped'): LastRescue => ({
      at: '2026-01-01T00:00:00.000Z',
      worktrees: [],
      ...(terminalStatus === undefined
        ? {}
        : { terminal: { status: terminalStatus, seenAt: '2026-01-01T00:00:00.000Z' } }),
    });
    const NOW = Date.parse('2026-12-01T00:00:00.000Z');

    it('rescueStashRemovalDue: 猶予の対象は done / failed / stopped だけ（lost・running・waiting_human・未知は時間で消さない）', () => {
      expect(
        tableOf((status) =>
          rescueStashRemovalDue(
            status,
            rescue(
              status === 'done' || status === 'failed' || status === 'stopped' ? status : 'done',
            ),
            NOW,
          ),
        ),
      ).toEqual({
        running: false,
        waiting_human: false,
        done: true,
        failed: true,
        lost: false,
        stopped: true,
        bogus: false,
      });
    });

    it('syncTerminalMark: 猶予の対象の値には印を足し（null でない）、ほかは印が無ければ null', () => {
      expect(
        tableOf(
          (status) => syncTerminalMark(status, rescue(), '2026-10-29T00:00:00.000Z') !== null,
        ),
      ).toEqual({
        running: false,
        waiting_human: false,
        done: true,
        failed: true,
        lost: false,
        stopped: true,
        bogus: false,
      });
    });

    it('pruneRescueLedger: running / waiting_human は null（触らない）。ほかは null ではない（lost・未知を含む）', () => {
      // 何も保持されていない古い作業ツリーを1つ持つ台帳: 触ってよい値なら消えて undefined になる
      const withStale: LastRescue = {
        ...rescue(),
        worktrees: [{ relativePath: 'w', branch: null, at: '2026-01-01T00:00:00.000Z' }],
      };
      expect(tableOf((status) => pruneRescueLedger(status, withStale, NOW) === null)).toEqual({
        running: true,
        waiting_human: true,
        done: false,
        failed: false,
        lost: false,
        stopped: false,
        bogus: false,
      });
    });
  });
});

describe('判定どうしで答えが食い違う値（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('⚠ waiting_human: 「動いている」は判定によって違う（isManagerInFlight / taskStatusForJob は動いている、isRunningJobStatus は動いていない）', () => {
    expect(isManagerInFlight('waiting_human')).toBe(true);
    expect(taskStatusForJob('waiting_human')).toBe('waiting');
    expect(isRunningJobStatus('waiting_human')).toBe(false);
  });

  it('⚠ 未知の値: 倒れ先が割れる（isRunningJobStatus は実行中、isManagerInFlight は実行中でない、isTerminalJobStatus は undefined、taskStatusForJob は needs_decision）', () => {
    expect(isRunningJobStatus(UNKNOWN)).toBe(true);
    expect(isManagerInFlight(UNKNOWN)).toBe(false);
    expect(isTerminalJobStatus(UNKNOWN)).toBeUndefined();
    expect(taskStatusForJob(UNKNOWN)).toBe('needs_decision');
  });

  it('⚠ done: isTerminalJobStatus は終端だが、再び走り出せる（done は idle を兼ねる）。isManagerInFlight は false で、「終わった」と「もう動かない」が一致しない', () => {
    expect(isTerminalJobStatus('done')).toBe(true);
    expect(isManagerInFlight('done')).toBe(false);
    expect(isManagerOutcomeUnobserved('done')).toBe(false);
  });

  it('⚠ stopped: isTerminalJobStatus は終端だが、isManagerOutcomeUnobserved（lost/failed）にも isManagerAwaitingJudgement（lost）にも入らない', () => {
    expect(isTerminalJobStatus('stopped')).toBe(true);
    expect(isManagerOutcomeUnobserved('stopped')).toBe(false);
    expect(isManagerAwaitingJudgement('stopped')).toBe(false);
  });
});
