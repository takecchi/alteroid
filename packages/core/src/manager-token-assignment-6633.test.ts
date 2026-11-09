import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerTokenAssignmentPort } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerManagerState,
  type RunnerResumeCommand,
  type RunnerStartCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

const ACTIVE = { tokenId: 'tok-active', generation: 3, fingerprint: 'fp-active' };

// 割り当ての口の作り物: 委譲ごとに決めた鍵を返し、呼ばれた hint を控える
function fakeAssignment(choose: (managerId: string, prior?: string) => string | undefined) {
  const targets = new Map<string, { tokenId: string; generation: number; fingerprint: string }>();
  const hints: { managerId: string; prior?: string }[] = [];
  let generation = 1_000;
  const port: ManagerTokenAssignmentPort = {
    async assign(managerId, hint) {
      hints.push({ managerId, ...hint });
      const tokenId = choose(managerId, hint.prior);
      if (tokenId === undefined) {
        targets.delete(managerId);
        return undefined;
      }
      const current = targets.get(managerId);
      const identity =
        current?.tokenId === tokenId
          ? current
          : { tokenId, generation: ++generation, fingerprint: `fp-${tokenId}` };
      targets.set(managerId, identity);
      return { ...identity, value: `tok-fake-value-${tokenId}` };
    },
    target: (managerId) => targets.get(managerId),
  };
  return { port, hints, targets };
}

function recordingRunner() {
  const starts: RunnerStartCommand[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const alive: RunnerManagerState[] = [];
  const runner = fakeRunnerClient({
    async start(command) {
      starts.push(command);
      return { cwd: command.cwd };
    },
    async resume(command) {
      resumes.push(command);
      return { cwd: command.cwd };
    },
    async list() {
      return [...alive];
    },
  });
  return { runner, starts, resumes };
}

describe('配り方 balanced: 委譲ごとに割り当てた鍵で起こす（#6633）', () => {
  it('起こすとき、割り当てた鍵を runner の命令に載せ、台帳には id だけを残す', async () => {
    const stores = createMemoryStores();
    const fake = recordingRunner();
    const assignment = fakeAssignment(() => 'tok-b');
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
      tokenIdentity: () => ACTIVE,
      tokenAssignment: assignment.port,
    });
    await pool.restore();

    const { managerId } = await pool.start({ request: '調べて' });

    expect(fake.starts[0]?.agentToken).toEqual({ value: 'tok-fake-value-tok-b' });
    // 載る runner をコンテナとして渡す（#6642）: 同じ runner の委譲を同じ鍵へ寄せるため
    expect(assignment.hints).toEqual([{ managerId, container: 'runner-primary' }]);
    const job = await stores.jobs.getJob(managerId);
    expect(job?.tokenAssignment).toEqual({ tokenId: 'tok-b' });
    expect(JSON.stringify(job)).not.toContain('tok-fake-value');
    await pool.stop();
  });

  it('一覧の世代は割り当てと比べる（現役と違っても ⚠ にならない）', async () => {
    const stores = createMemoryStores();
    const fake = recordingRunner();
    const assignment = fakeAssignment(() => 'tok-b');
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
      tokenIdentity: () => ACTIVE,
      tokenAssignment: assignment.port,
    });
    await pool.restore();

    const { managerId } = await pool.start({ request: '調べて' });
    const summary = (await pool.list()).find((entry) => entry.managerId === managerId);

    expect(summary?.tokenGeneration).toBe(assignment.targets.get(managerId)?.generation);
    expect(summary?.activeTokenGeneration).toBe(summary?.tokenGeneration);
    expect(summary?.activeTokenGeneration).not.toBe(ACTIVE.generation);
    await pool.stop();
  });

  it('割り当てが無い（failover）なら、命令は従来と1文字も変わらず、世代は現役と比べる', async () => {
    const stores = createMemoryStores();
    const fake = recordingRunner();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
      tokenIdentity: () => ACTIVE,
      tokenAssignment: fakeAssignment(() => undefined).port,
    });
    await pool.restore();

    const { managerId } = await pool.start({ request: '調べて' });

    expect(fake.starts[0]).not.toHaveProperty('agentToken');
    expect((await stores.jobs.getJob(managerId))?.tokenAssignment).toBeUndefined();
    const summary = (await pool.list()).find((entry) => entry.managerId === managerId);
    expect(summary?.tokenGeneration).toBe(ACTIVE.generation);
    await pool.stop();
  });

  it('resume では台帳に残った前の鍵を手がかりに渡し、割り当てた鍵を命令に載せる', async () => {
    const stores = createMemoryStores();
    const done: Job = {
      id: 'mgr-done',
      managerId: 'mgr-done',
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
      status: 'done',
      summary: '調べもの',
      request: '調べて',
      cwd: '/work/project',
      sessionId: 'sess-1',
      runnerId: 'runner-primary',
      tokenAssignment: { tokenId: 'tok-c' },
    };
    await stores.jobs.putJob(done);
    const fake = recordingRunner();
    const assignment = fakeAssignment((_id, prior) => prior ?? 'tok-x');
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
      tokenIdentity: () => ACTIVE,
      tokenAssignment: assignment.port,
    });
    await pool.restore();

    await pool.send('mgr-done', '続きを');

    // #6642 で再開する先の runner（コンテナ）も渡すようになった: 期待値に足した（前の鍵を渡すことの確認はそのまま）
    expect(assignment.hints).toContainEqual({
      managerId: 'mgr-done',
      prior: 'tok-c',
      container: 'runner-primary',
    });
    expect(fake.resumes.at(-1)?.agentToken).toEqual({ value: 'tok-fake-value-tok-c' });
    await pool.stop();
  });

  it('割り当ての口が投げても、委譲は現役で起きる（仕事を止めない）', async () => {
    const stores = createMemoryStores();
    const fake = recordingRunner();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
      tokenIdentity: () => ACTIVE,
      tokenAssignment: {
        assign: () => Promise.reject(new Error('帳面が読めない')),
        target: () => undefined,
      },
    });
    await pool.restore();

    await pool.start({ request: '調べて' });

    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).not.toHaveProperty('agentToken');
    await pool.stop();
  });
});
