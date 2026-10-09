import { describe, expect, it } from 'vitest';

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
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  raw(event: RunnerEvent): void;
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

  const deliver = (raw: RunnerEvent): void => {
    // 境界（runnerEventSchema.safeParse）を実際に通す: スキーマに無い欄はここで落ちるため。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  };

  return {
    runner,
    alive,
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      deliver({ type: 'closed', managerId, status, reason });
    },
    raw: deliver,
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
  clock: { now: number };
}

async function runningManualSetup(
  managerId: string,
  jobOverrides: Partial<Job> = {},
  existingStores?: Stores,
): Promise<ManualSetup> {
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
    ...jobOverrides,
  };
  const stores = existingStores ?? createMemoryStores();
  if (existingStores === undefined) await stores.jobs.putJob(job);

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
  const clock = { now: Date.now() };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock.now,
    // 既定 3000ms より大きく取る: 実時間で窓が閉じないようにし、閉じるのは `pool.stop()` の flush だけにする。
    synthesizedNoticeWindowMs: 60_000,
  });

  await pool.restore();
  await settle();

  return { pool, stores, inbox, fake, clock };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
}

const SESSION_CLOSED = 'マネージャーのセッションが閉じた。';

function noticesAbout(inbox: readonly InboxEvent[], from: number, managerId: string): string[] {
  return inbox
    .slice(from)
    .filter((e) => e.type === 'manager_message' && e.managerId === managerId)
    .map((e) => JSON.stringify(e));
}

describe('同じ closed(done) の二重配達（#3199 の知らせ。#3187 は failed だけを塞いだ）', () => {
  it('report 無しの closed(done) が2回配られても、「report を出さないまま終わった」知らせは1本だけ', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-done-dup');
    const before = inbox.length;
    fake.closed('mgr-done-dup', 'done', SESSION_CLOSED);
    await settle();
    fake.closed('mgr-done-dup', 'done', SESSION_CLOSED);
    await settle();
    await pool.stop();
    const joined = noticesAbout(inbox, before, 'mgr-done-dup').join('\n');
    // 比較の足場: 知らせ自体は届いている（空同士の比較にしない）。
    expect(joined).toContain('report を出さないまま終わった');
    expect(joined).not.toContain('×2');
  });

  async function decisionLines(setup: ManualSetup): Promise<string[]> {
    const entries = await setup.stores.journal.list({ types: ['exchange'] });
    return entries
      .map((e) => JSON.stringify(e))
      .filter((line) => line.includes('report 無しの closed(done)'));
  }

  it('(a) resume で新しいセッションになった後の report 無しの closed(done) は、新しい終わりとして知らせる', async () => {
    const setup = await runningManualSetup('mgr-done-again');
    const { pool, inbox, fake, clock } = setup;
    fake.closed('mgr-done-again', 'done', '1回目の終わり: first-end');
    await settle();
    clock.now += 60 * 60 * 1000;
    const sent = await pool.send('mgr-done-again', '続きを');
    expect(sent.outcome).toBe('delivered');
    clock.now += 60 * 1000;
    fake.closed('mgr-done-again', 'done', '2回目の終わり: second-end');
    await settle();
    await pool.stop();
    const text = JSON.stringify(inbox.filter((e) => e.type === 'manager_message'));
    expect(text).toContain('second-end');
    expect(await decisionLines(setup)).toHaveLength(2);
    expect((await decisionLines(setup)).join('\n')).not.toContain('知らせ済み');
  });

  it('(b) デーモンを作り直した後に同じ closed(done) が再び届いても、知らせない（印が台帳にある）', async () => {
    const first = await runningManualSetup('mgr-done-restart');
    first.fake.closed('mgr-done-restart', 'done', SESSION_CLOSED);
    await settle();
    await first.pool.stop();
    const persisted = (await first.stores.jobs.listJobs()).find((j) => j.id === 'mgr-done-restart');
    expect(persisted?.silentDoneNotifiedFor).toBe(persisted?.runnerSessionSince ?? '');
    expect(noticesAbout(first.inbox, 0, 'mgr-done-restart').join('')).toContain(
      'report を出さないまま終わった',
    );

    const second = await runningManualSetup('mgr-done-restart', {}, first.stores);
    const before = second.inbox.length;
    second.fake.closed('mgr-done-restart', 'done', SESSION_CLOSED);
    await settle();
    await second.pool.stop();
    expect(noticesAbout(second.inbox, before, 'mgr-done-restart')).toHaveLength(0);
    expect((await decisionLines(second)).join('\n')).toContain('知らせ済み');
  });
});
