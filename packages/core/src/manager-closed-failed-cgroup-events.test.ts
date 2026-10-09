import { describe, expect, it, vi } from 'vitest';

import type { CgroupEventsDelta } from './cgroup-events.js';
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
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, reason: string, cgroupEvents?: CgroupEventsDelta): void;
  reported(managerId: string, text: string): void;
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

  function send(raw: RunnerEvent): void {
    // 境界（runnerEventSchema.safeParse）を実際に通す: 欄なしの古い runner の closed が落ちないことは、ここを通さないと測れない。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  }

  return {
    runner,
    alive,
    closed(managerId, reason, cgroupEvents) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      send({
        type: 'closed',
        managerId,
        status: 'failed',
        reason,
        ...(cgroupEvents !== undefined ? { cgroupEvents } : {}),
      });
    },
    reported(managerId, text) {
      send({ type: 'report', managerId, text, status: 'done' });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(managerId = 'mgr-quota'): Promise<ManualSetup> {
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

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

function reportTextsOf(inbox: InboxEvent[]): string[] {
  return inbox
    .filter((event) => event.type === 'manager_message' && event.kind === 'report')
    .map((event) => (event as { text: string }).text);
}

async function listedOf(pool: ManagerPool, managerId: string) {
  const all = await pool.list();
  const found = all.find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found;
}

describe('event.cgroupEvents が、受信箱の本文と台帳の両方まで実際に届く（#1517）', () => {
  it('4. 正の値があるとき、配られた本文に数がそのまま乗る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-positive');
    const before = reportTextsOf(inbox).length;

    fake.closed('mgr-positive', 'マネージャーのセッションが落ちた: Error: SIGABRT', {
      pidsMaxDelta: 3,
      oomKillDelta: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const texts = reportTextsOf(inbox).slice(before);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    expect(text).toContain('マネージャーのセッションが落ちた: Error: SIGABRT');
    expect(text).toContain('3');
    expect(text).toContain('1');

    const listed = await listedOf(pool, 'mgr-positive');
    expect(listed.lastCgroupEvents).toEqual({
      pidsMaxDelta: 3,
      oomKillDelta: 1,
      at: expect.any(String) as unknown as string,
    });
  });

  it('4. 両方 0 のとき、配られた本文に「起きていなかった」の断定が乗る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-zero');
    const before = reportTextsOf(inbox).length;

    fake.closed('mgr-zero', 'マネージャーのセッションが落ちた: Error: SIGABRT', {
      pidsMaxDelta: 0,
      oomKillDelta: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const texts = reportTextsOf(inbox).slice(before);
    const text = texts[0] ?? '';
    expect(text).toContain('起きていなかった');
  });

  it('3. 古い runner（cgroupEvents 欄なし）の closed が通り、本文には D の定型文が乗る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-old-runner');
    const before = reportTextsOf(inbox).length;

    fake.closed('mgr-old-runner', 'マネージャーのセッションが落ちた: Error: 何か');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const texts = reportTextsOf(inbox).slice(before);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    expect(text).toContain('マネージャーのセッションが落ちた: Error: 何か');
    expect(text).toContain('この欄では判定できなかった');

    const listed = await listedOf(pool, 'mgr-old-runner');
    expect(listed.lastCgroupEvents).toBeUndefined();
    expect(Object.hasOwn(listed as object, 'lastCgroupEvents')).toBe(false);
  });

  it('古びる: 立った直後は在り、起こし直されて report が届くと欄ごと消える', async () => {
    const { pool, fake } = await runningManualSetup('mgr-stale');

    fake.closed('mgr-stale', 'マネージャーのセッションが落ちた: Error: SIGABRT', {
      pidsMaxDelta: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await listedOf(pool, 'mgr-stale')).lastCgroupEvents).toBeDefined();

    fake.alive.push({
      managerId: 'mgr-stale',
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
    });
    fake.reported('mgr-stale', '起こし直して、普通に報告した');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = await listedOf(pool, 'mgr-stale');
    expect(after.lastCgroupEvents).toBeUndefined();
    expect(Object.hasOwn(after as object, 'lastCgroupEvents')).toBe(false);

    await pool.stop();
  });
});
