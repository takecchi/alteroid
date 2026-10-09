import { describe, expect, it, vi } from 'vitest';

import type { CgroupEventsDelta } from './cgroup-events.js';
import { CGROUP_EVENTS_UNKNOWN_NOTE } from './cgroup-events.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { SystemErrorFacts } from './system-error.js';
import { createMemoryStores } from './testing.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  revive(managerId: string): void;
  closed(
    managerId: string,
    status: 'done' | 'failed',
    facts?: { cgroupEvents?: CgroupEventsDelta; systemError?: SystemErrorFacts },
  ): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
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
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    alive,
    revive(managerId) {
      alive.push({
        managerId,
        status: 'running',
        cwd: '/work/project',
        request: '調べて',
        waiting: [],
      });
    },
    closed(managerId, status, facts) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      const raw: RunnerEvent = {
        type: 'closed',
        managerId,
        status,
        reason: `${status} で畳んだ`,
        ...(facts?.cgroupEvents !== undefined ? { cgroupEvents: facts.cgroupEvents } : {}),
        ...(facts?.systemError !== undefined ? { systemError: facts.systemError } : {}),
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
  };
}

async function runningManualSetup(managerId: string) {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  return { pool, fake };
}

async function listedOf(pool: ManagerPool, managerId: string) {
  const found = (await pool.list()).find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found;
}

async function listedWhen(
  pool: ManagerPool,
  managerId: string,
  until: (m: Awaited<ReturnType<typeof listedOf>>) => boolean,
) {
  await vi.waitFor(async () => {
    if (!until(await listedOf(pool, managerId))) throw new Error('closed の反映がまだ');
  });
  return listedOf(pool, managerId);
}

const FIRST_SYSTEM_ERROR: SystemErrorFacts = {
  code: 'EAGAIN',
  errno: -11,
  syscall: 'spawn /app/node_modules/.bin/claude',
};

describe('closed を受けた時点で、前の回の lastCgroupEvents / lastSystemError を消す（#2463）', () => {
  it('1回目の failed で欄が立ち、resume 後の2回目の failed で欄が無ければ、1回目の値は残らない', async () => {
    const { pool, fake } = await runningManualSetup('mgr-twice');

    fake.closed('mgr-twice', 'failed', {
      cgroupEvents: { pidsMaxDelta: 3 },
      systemError: FIRST_SYSTEM_ERROR,
    });
    const first = await listedWhen(pool, 'mgr-twice', (m) => m.lastCgroupEvents !== undefined);
    expect(first.lastCgroupEvents).toMatchObject({ pidsMaxDelta: 3 });
    expect(first.lastSystemError).toMatchObject({ code: 'EAGAIN' });

    // 台帳も本当に resume する: 台帳が `failed` のまま同じ `closed(failed)` が届くのは二重配達として日誌だけに残す扱いなので、
    // resume で `running` へ戻してから2回目を流す。
    await pool.send('mgr-twice', '続きを');
    fake.revive('mgr-twice');
    fake.closed('mgr-twice', 'failed');
    const second = await listedWhen(pool, 'mgr-twice', (m) => m.lastCgroupEvents === undefined);
    expect(second.status).toBe('failed');
    expect(second.lastCgroupEvents).toBeUndefined();
    expect(Object.hasOwn(second as object, 'lastCgroupEvents')).toBe(false);
    expect(CGROUP_EVENTS_UNKNOWN_NOTE).toContain('判定できなかった');
    expect(second.lastSystemError).toBeUndefined();
    expect(Object.hasOwn(second as object, 'lastSystemError')).toBe(false);

    await pool.stop();
  });

  it('2回目に欄が在れば、1回目ではなく2回目の値になる', async () => {
    const { pool, fake } = await runningManualSetup('mgr-replace');

    fake.closed('mgr-replace', 'failed', {
      cgroupEvents: { pidsMaxDelta: 3 },
      systemError: FIRST_SYSTEM_ERROR,
    });
    await listedWhen(pool, 'mgr-replace', (m) => m.lastCgroupEvents?.pidsMaxDelta === 3);

    // 台帳も本当に resume する: `failed` のまま同じ `closed(failed)` が届くのは二重配達として日誌だけに残す扱いなので、`running` へ戻してから2回目を流す。
    await pool.send('mgr-replace', '続きを');
    fake.revive('mgr-replace');
    fake.closed('mgr-replace', 'failed', {
      cgroupEvents: { oomKillDelta: 2 },
      systemError: { code: 'ENOMEM' },
    });
    const second = await listedWhen(
      pool,
      'mgr-replace',
      (m) => m.lastCgroupEvents?.oomKillDelta === 2,
    );
    expect(second.lastCgroupEvents?.oomKillDelta).toBe(2);
    expect(second.lastCgroupEvents?.pidsMaxDelta).toBeUndefined();
    expect(second.lastSystemError?.code).toBe('ENOMEM');
    expect(second.lastSystemError?.errno).toBeUndefined();

    await pool.stop();
  });

  it('failed 以外（done）で閉じた回も、前の回の値を貼り付けたままにしない', async () => {
    const { pool, fake } = await runningManualSetup('mgr-then-done');

    fake.closed('mgr-then-done', 'failed', {
      cgroupEvents: { pidsMaxDelta: 3 },
      systemError: FIRST_SYSTEM_ERROR,
    });
    await listedWhen(pool, 'mgr-then-done', (m) => m.lastCgroupEvents?.pidsMaxDelta === 3);

    fake.revive('mgr-then-done');
    fake.closed('mgr-then-done', 'done');
    const after = await listedWhen(pool, 'mgr-then-done', (m) => m.status === 'done');
    expect(after.lastCgroupEvents).toBeUndefined();
    expect(after.lastSystemError).toBeUndefined();

    await pool.stop();
  });
});
