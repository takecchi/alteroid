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

async function journalContains(stores: Stores, needle: string): Promise<boolean> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.some((entry) => JSON.stringify(entry).includes(needle));
}

describe('#799: closed(failed) の本文が、合流窓を flush させなくても日誌に残る', () => {
  it('歯A: flush させていない時点で、日誌に本文（reason）を含む行が在る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-a');
    const reportsBefore = inbox.filter(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    ).length;
    const reason = 'マネージャーのセッションが落ちた: Error: 何か（歯A）';

    fake.closed('mgr-a', 'failed', reason);

    await vi.waitFor(async () => {
      if (!(await journalContains(stores, reason))) {
        throw new Error('closed_failed の本文がまだ日誌に無い');
      }
    });

    const entries = await stores.journal.list({ types: ['exchange'] });
    const line = entries.find((entry) => JSON.stringify(entry).includes(reason));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).toContain('mgr-a');

    const reportsAfter = inbox.filter(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    ).length;
    expect(reportsAfter).toBe(reportsBefore);

    await pool.stop();
  });

  it('歯B: flush が走った後も、本文を含む行は消えずに残っている（歯Aの主張は flush の有無に依存しない）', async () => {
    const { pool, stores, fake } = await runningManualSetup('mgr-b');
    const reason = 'マネージャーのセッションが落ちた: Error: 何か（歯B）';

    fake.closed('mgr-b', 'failed', reason);

    await vi.waitFor(async () => {
      if (!(await journalContains(stores, reason))) {
        throw new Error('closed_failed の本文がまだ日誌に無い（flush 前）');
      }
    });

    await pool.stop();

    expect(await journalContains(stores, reason)).toBe(true);
  });
});

describe('#799: resume_fallback（#notifyResumeFallback）の拡張文言が、flush 前に日誌へ残る', () => {
  it('前のセッションへ戻れず生ログから続けた回、拡張文言（新しいセッションを起こして続けさせた）が flush 前に日誌へ残る', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup('mgr-c');
    const reason = '前のセッションが切れていた（歯C）';

    fake.resumeFailed('mgr-c', 'sess-mgr-c', reason, true);

    const marker = '新しいセッションを起こして続けさせた';
    await vi.waitFor(async () => {
      if (!(await journalContains(stores, marker))) {
        throw new Error('resume_fallback の拡張文言がまだ日誌に無い');
      }
    });

    const entries = await stores.journal.list({ types: ['exchange'] });
    const line = entries.find((entry) => JSON.stringify(entry).includes(marker));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).toContain('mgr-c');

    const reportsAfter = inbox.filter(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reportsAfter).toHaveLength(1);

    await pool.stop();
  });
});
