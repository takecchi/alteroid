import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// `Pool#resume`（`#resume`）の早い return のうち、既存の試験が1本も縛っていなかったものを、
// 外から見える結果（台帳の行・runner への命令の記録・`restore()` の戻り・`pool.list()`）だけで縛る。
// 段（非公開メソッド）へ分けるときに早い return を取り違えると落ちる。
//
// 一時の変更で外して確かめた結果（`ALT_MUT_U`。コミットしない）:
//   - 入口の no-session / workspace-path-unknown / 貸し出しの関門の held-by-lease / unreadable /
//     チェックポイント1 の stopped-meanwhile / resume 失敗の再 throw は、既存の試験が落ちる（ここでは足さない）
//   - チェックポイント2（`runner.resume()` の応答の後）の stopped-meanwhile だけは、`send()` 経由だと
//     呼び元の3つ目の確かめ（`#settleStoppedMeanwhile`）が同じ結果を返すので外から見えない。
//     `restore()`（`#restoreJobs`）経由なら、外すと止めた委譲が `running` へ書き戻されるので、ここで縛る。

const START = '2026-09-01T00:00:00.000Z';
const CLOCK = Date.parse(START);

function runningJob(managerId: string): Job {
  return {
    id: managerId,
    createdAt: START,
    updatedAt: START,
    status: 'running',
    summary: '調べ物',
    request: '調べ物をして',
    cwd: '/work/project',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };
}

function trackingRunner(resumeGate: Promise<void>, onResumeEntered: () => void) {
  const sessions = new Set<string>();
  const stopCalls: string[] = [];
  const resumeCalls: RunnerResumeCommand[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {},
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      resumeCalls.push(command);
      onResumeEntered();
      await resumeGate;
      sessions.add(command.managerId);
      return { cwd: command.cwd };
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      stopCalls.push(managerId);
      sessions.delete(managerId);
    },
    async list(): Promise<RunnerManagerState[]> {
      return [...sessions].map((id) => ({
        managerId: id,
        status: 'running',
        cwd: '/work/project',
        request: '調べ物',
        waiting: [],
        liveBackgroundTasks: 0,
      }));
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {},
  };
  return { runner, sessions, stopCalls, resumeCalls };
}

describe('resume: 応答の後の止められた確かめ（チェックポイント2）', () => {
  it('runner.resume() の応答を待つ間に abort() が確定したら、restore() は running へ書き戻さず、起こされたセッションを畳み直す', async () => {
    const managerId = 'mgr-resume-midstop';
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob(managerId));

    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const { runner, sessions, stopCalls, resumeCalls } = trackingRunner(gate, markEntered);

    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([runner]),
      now: () => CLOCK,
    });

    const restoring = pool.restore();
    await entered;
    // resume は応答待ち。この間に止める（セッションはまだ無いので、止めは1回で確定する）。
    const aborted = await pool.abort(managerId);
    expect(aborted.outcome).toBe('stopped');
    expect(stopCalls).toEqual([managerId]);
    expect((await stores.jobs.getJob(managerId))?.status).toBe('stopped');

    open();
    const restored = await restoring;

    // 受理の後で止まっていたので「戻せた」にしない。
    expect(restored).toEqual([]);
    expect(resumeCalls).toHaveLength(1);
    // 応答の後に立ったセッションを、止めた意思に従って畳み直す（`runner.stop()` がもう1回）。
    expect(stopCalls).toEqual([managerId, managerId]);
    expect(sessions.has(managerId)).toBe(false);
    // 台帳は止めたまま（running へ戻さない）。
    expect((await stores.jobs.getJob(managerId))?.status).toBe('stopped');
    const listed = (await pool.list()).find((entry) => entry.managerId === managerId);
    expect(listed?.status).toBe('stopped');
  });
});
