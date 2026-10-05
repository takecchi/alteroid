import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * **台帳が `attached=false` のまま runner に旧プロセスが生きているとき、resume は
 * 旧プロセスへ短絡し、デーモンは世代を現役へ書き換える**（Issue #2877）。
 *
 * ## 到達する実際の経路
 *
 * デーモンの再起動。`restore()` が引き取るのは `running` / `waiting_human` の台帳だけで、
 * **done の委譲は `#records` に載らない**（デーモンの停止は runner のセッションを止めない
 * ので、done のセッションは runner で生きたまま）。その後の `manager_send` は `#load` が
 * `attached: false` の像を作り、既存の resume 経路（`#resumeOnce`）へ落ちる。
 * `runner.ts` の `Host#resume` は生きたセッションが居るとそこへ message を push して返す
 * （歯は `runner-token-rotation.test.ts` の「resume が生きた旧プロセスへ短絡する」）ので、
 * 新しい SDK は起きないが、`#resume` は成功を受けて `#rememberTokenIdentity` を呼ぶ。
 *
 * 応答（`{ cwd }`）には短絡したかどうかが無いので、デーモンは区別できない。
 */

const JOB: Job = {
  id: 'mgr-alive',
  managerId: 'mgr-alive',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T01:00:00.000Z',
  status: 'done',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

/** `Host#resume` と同じく、生きたセッションが居れば新しい SDK を起こさず message を流して返す偽 runner。 */
function shortcutRunner() {
  const alive: RunnerManagerState[] = [
    {
      managerId: 'mgr-alive',
      status: 'done',
      cwd: '/work/project',
      request: '調べておいて',
      waiting: [],
      sessionId: 'sess-1',
    },
  ];
  const pushedToLiveProcess: string[] = [];
  const spawned: RunnerResumeCommand[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {
      /* この検証では使わない */
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      if (alive.some((state) => state.managerId === command.managerId)) {
        if (command.message !== undefined) pushedToLiveProcess.push(command.message);
        return { cwd: '/work/project' };
      }
      spawned.push(command);
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return [...alive];
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
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return { runner, pushedToLiveProcess, spawned };
}

describe('resume が生きた旧プロセスへ短絡したとき、世代を「一致」にしない（#2877）', () => {
  it('⚠️ デーモン再起動後の done へ send して旧プロセスへ流れた回は、抱えている世代を現役と名乗らない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(JOB);
    const fake = shortcutRunner();
    const registry = createRunnerRegistry([fake.runner]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
      tokenIdentity: () => ({ tokenId: 'tok-b', generation: 60 }),
    });
    await pool.restore();
    const before = (await pool.list()).find((s) => s.managerId === 'mgr-alive');
    // 再起動後は、旧プロセスがどの世代かをデーモンは知らない。
    expect(before?.tokenGeneration).toBeUndefined();

    const result = await pool.send('mgr-alive', '続きを');

    expect(result.outcome).toBe('delivered');
    // 前提: この回は新しい SDK を起こさず、生きた旧プロセスへ流れた。
    expect(fake.spawned).toHaveLength(0);
    expect(fake.pushedToLiveProcess).toEqual(['続きを']);
    // 旧プロセスの鍵が現役かどうかは確かめていない。それなのに「一致」と名乗らない。
    const after = (await pool.list()).find((s) => s.managerId === 'mgr-alive');
    expect(after?.tokenGeneration).not.toBe(60);
    await pool.stop();
  });
});
