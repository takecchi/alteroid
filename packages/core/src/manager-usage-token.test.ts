import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import type { UsageTotals } from './usage.js';

const RUNNING_JOB: Job = {
  id: 'mgr-tok',
  managerId: 'mgr-tok',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
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

/**
 * 判定に効く口（`connect` / `list` / `resume`）を緩めない: 緩めると、引き取りが起きていないのに
 * 起きたことになる。
 */
function usageRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      // 同期的に名乗らせない（本物は `void this.#pump(...)` で即 return する）。
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
    peerUsage(models: Record<string, UsageTotals>, extra: { unmetered?: boolean } = {}): void {
      if (emit === null) throw new Error('connect されていない');
      emit({
        type: 'peer_usage',
        managerId: 'mgr-tok',
        provider: 'codex',
        sessionId: 'thr-1',
        models,
        ...extra,
      } as unknown as RunnerEvent);
    },
    usage(models: Record<string, UsageTotals>): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit({
        type: 'usage',
        managerId: 'mgr-tok',
        sessionId: 'sess-1',
        models,
      } as unknown as RunnerEvent);
    },
  };
}

async function setup(options: {
  stores: Stores;
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
}) {
  await options.stores.jobs.putJob(RUNNING_JOB);
  const fake = usageRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores: options.stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores: options.stores, runners: registry }),
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
  });
  await pool.restore();
  return { pool, fake };
}

async function rowsOf(stores: Stores) {
  const { rows } = await stores.usage.aggregate({});
  return rows;
}

describe('マネージャーの消費に認証トークンの帰属が付く（#393 受け入れ基準6）', () => {
  it('現役の指名が在れば、その tokenId が行に載る', async () => {
    const stores = createMemoryStores();
    const s = await setup({
      stores,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 7 }),
    });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    const rows = await rowsOf(stores);
    expect(rows[0]?.tokenId).toBe('tok-a');
    expect(rows[0]?.managerId).toBe('mgr-tok');
    expect((await stores.usage.aggregate({})).tokensSince).not.toBeNull();

    await s.pool.stop();
  });

  it('現役の指名が無ければ帰属を渡さない（プールが空の器で軸が始まらない）', async () => {
    const stores = createMemoryStores();
    const s = await setup({ stores, tokenIdentity: () => undefined });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    const aggregate = await stores.usage.aggregate({});
    expect(aggregate.rows[0]?.tokenId).toBeUndefined();
    expect(aggregate.since).not.toBeNull();
    expect(aggregate.tokensSince).toBeNull();

    await s.pool.stop();
  });

  it('`tokenIdentity` を渡していない器でも帰属は空（口が任意であることそのもの）', async () => {
    const stores = createMemoryStores();
    const s = await setup({ stores });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    expect((await stores.usage.aggregate({})).rows[0]?.tokenId).toBeUndefined();

    await s.pool.stop();
  });

  it('帰属は「セッションが起きた瞬間の身元」である（消費が届くたびに読み直さない）', async () => {
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 1 };
    const s = await setup({ stores, tokenIdentity: () => current });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    current = { tokenId: 'tok-b', generation: 2 };
    s.fake.usage({ opus: totals({ costUsd: 3 }) });
    await expect
      .poll(async () => (await rowsOf(stores))[0]?.totals.costUsd, { timeout: 2000 })
      .toBe(3);

    const rows = await rowsOf(stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBe('tok-a');

    await s.pool.stop();
  });
});

describe('peer の消費（#486 S7）', () => {
  it('site=peer・層 manager で、増分のまま積む。マネージャー本体（session）の行とは別になる', async () => {
    const stores = createMemoryStores();
    const s = await setup({ stores });
    s.fake.peerUsage({ 'gpt-5': totals({ inputTokens: 100, outputTokens: 10 }) });
    s.fake.peerUsage({ 'gpt-5': totals({ inputTokens: 50 }) });
    await expect
      .poll(async () => (await rowsOf(stores))[0]?.totals.inputTokens, { timeout: 2000 })
      .toBe(150);
    const rows = await rowsOf(stores);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ layer: 'manager', site: 'peer', managerId: 'mgr-tok' });
    await s.pool.stop();
  });

  it('消費を報告しない provider は 0 を積まず、取れなかったターンとして数える', async () => {
    const stores = createMemoryStores();
    const s = await setup({ stores });
    s.fake.peerUsage({}, { unmetered: true });
    await expect
      .poll(async () => (await stores.usage.aggregate({})).unmeteredRows?.length, { timeout: 2000 })
      .toBe(1);
    expect(await rowsOf(stores)).toHaveLength(0);
    await s.pool.stop();
  });
});
