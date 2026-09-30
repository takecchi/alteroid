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

/**
 * **`closed` を受けた時点で、前の回の `lastCgroupEvents` / `lastSystemError` を
 * 消す（#2463）。**
 *
 * 同じ委譲が続けて `failed` で閉じ、2回目の `closed` に `cgroupEvents` /
 * `systemError` の欄が無いとき、1回目の値が「今回の落ち方」として
 * `manager_list` / `manager_report` に残ってはならない。両ツールは
 * `lastCgroupEvents === undefined` を「この欄では判定できなかった」
 * （`CGROUP_EVENTS_UNKNOWN_NOTE`）と読むので、ここでは両ツールが読む
 * `ManagerSummary`（`pool.list()`）が欄ごと無いことを測る。
 *
 * 足場は `manager-closed-failed-cgroup-events.test.ts` と同じ形（この歯専用に
 * 複製してある）。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  /** `resume` 後の状態を真似る（report を挟まず、同じ委譲が生きている）。 */
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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
    await settle();
    const first = await listedOf(pool, 'mgr-twice');
    expect(first.lastCgroupEvents).toMatchObject({ pidsMaxDelta: 3 });
    expect(first.lastSystemError).toMatchObject({ code: 'EAGAIN' });

    // resume され、report が一度も届かないまま、欄の無い failed で閉じる。
    fake.revive('mgr-twice');
    fake.closed('mgr-twice', 'failed');
    await settle();

    const second = await listedOf(pool, 'mgr-twice');
    // `manager_list` / `manager_report` はこの欄が undefined のとき
    // `CGROUP_EVENTS_UNKNOWN_NOTE`（判定できなかった）を出す。
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
    await settle();

    fake.revive('mgr-replace');
    fake.closed('mgr-replace', 'failed', {
      cgroupEvents: { oomKillDelta: 2 },
      systemError: { code: 'ENOMEM' },
    });
    await settle();

    const second = await listedOf(pool, 'mgr-replace');
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
    await settle();

    fake.revive('mgr-then-done');
    fake.closed('mgr-then-done', 'done');
    await settle();

    const after = await listedOf(pool, 'mgr-then-done');
    expect(after.lastCgroupEvents).toBeUndefined();
    expect(after.lastSystemError).toBeUndefined();

    await pool.stop();
  });
});
