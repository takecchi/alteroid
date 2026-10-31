import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// 注入した時計と、実時間（本番の `Date.now()`）が決して重ならない遠い過去
const CLOCK_MS = Date.parse('2001-02-03T04:05:06.000Z');
const CLOCK_ISO = '2001-02-03T04:05:06.000Z';

function manualRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
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
    push(event: RunnerEvent): void {
      emit?.(event);
    },
  };
}

async function setup(managerId: string) {
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
    liveBackgroundTasks: 0,
    managerId,
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
    now: () => CLOCK_MS,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  inbox.length = 0;
  return { pool, fake, inbox };
}

async function listedWhen(
  pool: ManagerPool,
  managerId: string,
  until: (m: Awaited<ReturnType<ManagerPool['list']>>[number]) => boolean,
) {
  return vi.waitFor(async () => {
    const found = (await pool.list()).find((m) => m.managerId === managerId);
    if (found === undefined || !until(found)) throw new Error('反映がまだ');
    return found;
  });
}

describe('注入した時計 #now() を、素の new Date() が迂回しない（#5975）', () => {
  it('closed(failed) が台帳へ書く lastSystemError / lastCgroupEvents の at は、注入した時計の値になる', async () => {
    const { pool, fake } = await setup('mgr-clock-closed');
    fake.push({
      type: 'closed',
      managerId: 'mgr-clock-closed',
      status: 'failed',
      reason: 'failed で畳んだ',
      systemError: { code: 'EAGAIN' },
      cgroupEvents: { pidsMaxDelta: 3 },
    } as RunnerEvent);
    const listed = await listedWhen(
      pool,
      'mgr-clock-closed',
      (m) => m.lastSystemError !== undefined,
    );
    expect(listed.lastSystemError?.at).toBe(CLOCK_ISO);
    expect(listed.lastCgroupEvents?.at).toBe(CLOCK_ISO);
    await pool.stop();
  });

  it('人間が止めたときの受信箱の manager_message の at は、注入した時計の値になる', async () => {
    const { pool, inbox } = await setup('mgr-clock-abort');
    await pool.abort('mgr-clock-abort', '試験', 'human');
    const message = inbox.find((event) => event.type === 'manager_message');
    expect(message?.at).toBe(CLOCK_ISO);
    await pool.stop();
  });
});
