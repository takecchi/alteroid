import { describe, expect, it, vi } from 'vitest';

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
  resumeFailed(managerId: string, sessionId: string, reason: string, recovered: boolean): void;
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
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      // 境界（runnerEventSchema.safeParse）を実際に通す: スキーマに無い欄はここで落ちるため。
      const raw: RunnerEvent = { type: 'closed', managerId, status, reason };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
    raw(event) {
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
    resumeFailed(managerId, sessionId, reason, recovered) {
      const raw: RunnerEvent = {
        type: 'resume_failed',
        managerId,
        sessionId,
        reason,
        recovered,
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(
  managerId: string,
  options: { synthesizedNoticeWindowMs?: number } = {},
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
    // 既定 3000ms より大きく取る: 実時間で窓が閉じると「flush させていない」状態を作れない。
    synthesizedNoticeWindowMs: options.synthesizedNoticeWindowMs ?? 60_000,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
}

describe('closed(failed) の二重配達（SSE 再送。#3187）', () => {
  it('同じ closed(failed) が2回配られても、日誌の失敗行は1本', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-dup');
    const reason = 'マネージャーのセッションが落ちた: Error: boom';
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    await pool.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const failureLines = entries.filter((e) => JSON.stringify(e).includes(`[mgr-dup] ${reason}`));
    expect(failureLines).toHaveLength(1);
  });

  it('同じ closed(failed) が2回配られても、知らせは「×2」にならない', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-dup');
    const reason = 'マネージャーのセッションが落ちた: Error: boom';
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    fake.closed('mgr-dup', 'failed', reason);
    await settle();
    await pool.stop();

    const notices = inbox.filter(
      (e) => e.type === 'manager_message' && JSON.stringify(e).includes('boom'),
    );
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain('×2');
  });

  it('同じ closed(failed) が2回配られても、器の失敗は1回しか数えない（noteManagerFailed）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      id: 'mgr-n',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '調べ物',
      request: '調べて',
      cwd: '/work/project',
      sessionId: 'sess-mgr-n',
      runnerId: 'runner-primary',
    });
    const fake = manualRunner();
    fake.alive.push({
      managerId: 'mgr-n',
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-mgr-n',
    });
    const registry = createRunnerRegistry([fake.runner]);
    const noted: string[] = [];
    const original = registry.noteManagerFailed.bind(registry);
    registry.noteManagerFailed = (runnerId: string) => {
      noted.push(runnerId);
      original(runnerId);
    };
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
      synthesizedNoticeWindowMs: 60_000,
    });
    await pool.restore();
    await vi.waitFor(() => {
      if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });
    fake.closed('mgr-n', 'failed', 'x');
    await settle();
    fake.closed('mgr-n', 'failed', 'x');
    await settle();
    await pool.stop();
    expect(noted).toEqual(['runner-primary']);
  });

  it('failed の後に resume されて running へ戻った委譲に届いた closed(failed) は、新しい失敗として従来どおり知らせる', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-again');
    fake.closed('mgr-again', 'failed', '1回目の失敗: boom1');
    await settle();
    const sent = await pool.send('mgr-again', '続きを');
    expect(sent.outcome).toBe('delivered');
    const job = (await stores.jobs.listJobs()).find((j) => j.id === 'mgr-again');
    expect(job?.status).toBe('running');
    fake.closed('mgr-again', 'failed', '2回目の失敗: boom2');
    await settle();
    await pool.stop();

    const text = JSON.stringify(inbox.filter((e) => e.type === 'manager_message'));
    expect(text).toContain('boom2');
  });

  it('failed の委譲を send が開き直している最中（台帳はまだ failed）に届いた closed(failed) は、重複と読まず新しい失敗として知らせる', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-inflight');
    fake.closed('mgr-inflight', 'failed', '1回目の失敗: boom1');
    await settle();
    // `send()` は resume の**後**で台帳を `running` に書くので、この窓では台帳はまだ `failed` である。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredResume = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fake.runner.resume = async () => {
      entered();
      await gate;
      return {};
    };
    const sending = pool.send('mgr-inflight', '続きを');
    await enteredResume;
    fake.closed('mgr-inflight', 'failed', '開き直した直後の失敗: boom-inflight');
    await settle();
    release();
    await sending;
    await settle();
    await pool.stop();

    const text = JSON.stringify(inbox.filter((e) => e.type === 'manager_message'));
    expect(text).toContain('boom-inflight');
  });

  it('対照: resume_failed(recovered=false) の後に closed(lost) が続く通常の lost は、受信箱に出る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-lost');
    const before = inbox.length;
    fake.resumeFailed('mgr-lost', 'sess-mgr-lost', '戻れない', false);
    await settle();
    fake.closed('mgr-lost', 'lost', '戻れない');
    await settle();
    await pool.stop();
    expect(inbox.slice(before)).not.toHaveLength(0);
  });
});
