import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import type { UsageTotals } from './usage.js';

const RUNNING_JOB: Job = {
  id: 'mgr-ctx',
  managerId: 'mgr-ctx',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-ctx',
  runnerId: 'runner-primary',
};

function totals(over: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    ...over,
  };
}

const SAMPLE_CONTEXT_USAGE = {
  durationMs: 5,
  totalTokens: 12_000,
  rawMaxTokens: 200_000,
  percentage: 6,
};

function usageRunner() {
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
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
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

  return {
    runner,
    // 境界（`runnerEventSchema.safeParse`）を実際に通す: スキーマに無い欄はここで黙って落ちる。
    usage(models: Record<string, UsageTotals>, contextUsage?: unknown): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      const raw = {
        type: 'usage',
        managerId: 'mgr-ctx',
        sessionId: 'sess-ctx',
        models,
        ...(contextUsage === undefined ? {} : { contextUsage }),
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit(parsed.data);
    },
    contextUsage(turnSucceeded: boolean, contextUsage: unknown): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      const raw = {
        type: 'context_usage',
        managerId: 'mgr-ctx',
        sessionId: 'sess-ctx',
        turnSucceeded,
        contextUsage,
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit(parsed.data);
    },
  };
}

async function setup(stores: Stores) {
  await stores.jobs.putJob(RUNNING_JOB);
  const fake = usageRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });
  await pool.restore();
  return { pool, fake, inbox };
}

async function turnUsageRows(
  stores: Stores,
): Promise<Extract<JournalEntry, { type: 'turn_usage' }>[]> {
  const entries = await stores.journal.list({ types: ['turn_usage'] });
  return entries.flatMap((entry) => (entry.type === 'turn_usage' ? [entry] : []));
}

async function contextUsageRows(
  stores: Stores,
): Promise<Extract<JournalEntry, { type: 'context_usage' }>[]> {
  const entries = await stores.journal.list({ types: ['context_usage'] });
  return entries.flatMap((entry) => (entry.type === 'context_usage' ? [entry] : []));
}

describe('マネージャーの turn_usage に contextUsage が載る経路（Issue #977 / #976）', () => {
  it('増分が非空なら turn_usage.contextUsage に値が載る（既存の読み手との互換のため今も残る経路）', async () => {
    const stores = createMemoryStores();
    const s = await setup(stores);

    s.fake.usage({ opus: totals({ costUsd: 1 }) }, SAMPLE_CONTEXT_USAGE);

    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]?.contextUsage).toEqual(SAMPLE_CONTEXT_USAGE);

    await s.pool.stop();
  });

  it('増分が空なら turn_usage の行そのものは今も無い（この関門自体は #976 で変えていない）', async () => {
    const stores = createMemoryStores();
    const s = await setup(stores);

    s.fake.usage({}, SAMPLE_CONTEXT_USAGE);

    // 即座に journal を見ると「まだ処理していない」と「本当に無い」が区別できないので、増分の有無に関わらず呼ばれる `usage.record` を完了の目印にする。
    await vi.waitFor(async () => {
      const { since } = await stores.usage.aggregate({});
      if (since === null) throw new Error('usage.record がまだ走っていない');
    });

    expect(await turnUsageRows(stores)).toHaveLength(0);

    await s.pool.stop();
  });

  it("⭐ `case 'context_usage'` は消費の増分・ターンの成否に関わらず必ず日誌へ書く（#976 が新設した経路）", async () => {
    const stores = createMemoryStores();
    const s = await setup(stores);

    s.fake.contextUsage(false, SAMPLE_CONTEXT_USAGE);

    const rows = await vi.waitFor(async () => {
      const found = await contextUsageRows(stores);
      if (found.length === 0) throw new Error('context_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]?.turnSucceeded).toBe(false);
    expect(rows[0]?.contextUsage).toEqual(SAMPLE_CONTEXT_USAGE);
    expect(await turnUsageRows(stores)).toHaveLength(0);

    await s.pool.stop();
  });
});
