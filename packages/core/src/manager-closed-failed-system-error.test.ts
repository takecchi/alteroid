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
import type { SystemErrorFacts } from './system-error.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, reason: string, systemError?: SystemErrorFacts): void;
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
    closed(managerId, reason, systemError) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      // 境界（runnerEventSchema.safeParse）を実際に通す: スキーマに無い欄はここで落ちるため。
      const raw: RunnerEvent = {
        type: 'closed',
        managerId,
        status: 'failed',
        reason,
        ...(systemError !== undefined ? { systemError } : {}),
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

describe('event.systemError が、合流窓を経てクローンの受信箱まで実際に届く（#713 段2）', () => {
  it('B: systemError が在るとき、配られた本文に code / errno / syscall が生の値のまま乗る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-b');
    const before = reportTextsOf(inbox).length;

    fake.closed('mgr-b', 'マネージャーのセッションが落ちた: Error: spawn …/claude EAGAIN', {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const texts = reportTextsOf(inbox).slice(before);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    expect(text).toContain('マネージャーのセッションが落ちた: Error: spawn …/claude EAGAIN');
    expect(text).toContain('code=EAGAIN');
    expect(text).toContain('errno=-11');
    expect(text).toContain('syscall=spawn /app/node_modules/.bin/claude');
  });

  it('D: systemError が無い（signal で畳まれた等）とき、配られた本文に「取れなかった」行が乗る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-d');
    const before = reportTextsOf(inbox).length;

    fake.closed('mgr-d', 'マネージャーのセッションが落ちた: Error: 何か');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const texts = reportTextsOf(inbox).slice(before);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    expect(text).toContain('マネージャーのセッションが落ちた: Error: 何か');
    expect(text).toContain('器の資源による落ち方かどうかは');
    expect(text).not.toContain('code=');
  });

  it(
    'A: 枠で落ちた回（systemError 無し）は、D の行に飲み込まれず reason の枠の文言が' +
      'そのまま読める——D の行が付いても「何も分からない」にならない',
    async () => {
      const { pool, inbox, fake } = await runningManualSetup('mgr-a');
      const before = reportTextsOf(inbox).length;

      const quotaReason =
        'マネージャーのセッションが落ちた: Error: ' +
        "You've hit your individual spend limit for this account.";
      fake.closed('mgr-a', quotaReason);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await pool.stop();

      const texts = reportTextsOf(inbox).slice(before);
      expect(texts).toHaveLength(1);
      const text = texts[0] ?? '';
      expect(text).toContain("You've hit your individual spend limit for this account.");
      expect(text).toContain('器の資源による落ち方かどうかは');
      expect(text).toContain('枠に当たった場合');
    },
  );
});
