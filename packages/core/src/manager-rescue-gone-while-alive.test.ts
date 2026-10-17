import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type UnpushedWorkResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, RescueWorktree } from './schema.js';
import { createMemoryStores } from './testing.js';

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  setUnpushedWorkResult(result: UnpushedWorkResult): void;
  rescueRef(managerId: string, worktrees: RescueWorktree[]): void;
}

// 名簿が接続の瞬間に `client.instanceId` を採る（`#open`）ので、器の `instanceId` はここで決まる
function manualRunner(instanceId: string): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  let unpushedWorkResult: UnpushedWorkResult | undefined;

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    instanceId,
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
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* この検証では使わない */
    },
    async unpushedWork() {
      return unpushedWorkResult;
    },
  };

  return {
    runner,
    alive,
    setUnpushedWorkResult(result) {
      unpushedWorkResult = result;
    },
    rescueRef(managerId, worktrees) {
      // daemon の境界を通す: スキーマに無い欄は黙って落ちるので、runner が送らない欄（instanceId / goneAt）が境界で通ることも確かめる
      const parsed = runnerEventSchema.safeParse(
        JSON.parse(JSON.stringify({ type: 'rescue_ref', managerId, worktrees })) as unknown,
      );
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
    },
  };
}

async function runningSetup(managerId: string, instanceId: string, now: () => number) {
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

  const fake = manualRunner(instanceId);
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  // 開く口（`open`）で登録する: 配列で渡す形だと名簿が `instanceId` を採らず、`#sighting` が器を名乗れない
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => fake.runner });
  const inbox: InboxEvent[] = [];
  const pool: ManagerPool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now,
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  return { pool, fake };
}

async function lastRescueOf(pool: ManagerPool, managerId: string) {
  const found = (await pool.list()).find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found.lastRescue;
}

const RESCUED_AT = '2026-10-05T01:00:00.000Z';
const SEEN_AT = '2026-10-05T01:10:00.000Z';

const rescuedTree: RescueWorktree = {
  relativePath: 'work/a',
  branch: 'feat/a',
  at: RESCUED_AT,
  pushed: {
    ref: 'refs/alteroid-rescue/mgr-gone/a-1234abcd',
    commit: 'a'.repeat(40),
    at: RESCUED_AT,
  },
};

describe('生きている器で作業ツリーが消えたことの印（#4985）', () => {
  it('rescue_ref を受けた器が同じまま、全部を見た観測にその作業ツリーが無ければ、台帳の項目へ goneAt が付く', async () => {
    let nowMs = Date.parse(RESCUED_AT);
    const { pool, fake } = await runningSetup('mgr-gone', 'inst-A', () => nowMs);
    fake.rescueRef('mgr-gone', [rescuedTree]);
    await vi.waitFor(async () => {
      expect((await lastRescueOf(pool, 'mgr-gone'))?.worktrees).toHaveLength(1);
    });
    expect((await lastRescueOf(pool, 'mgr-gone'))?.worktrees[0]).toMatchObject({
      instanceId: 'inst-A',
    });
    expect((await lastRescueOf(pool, 'mgr-gone'))?.worktrees[0]?.goneAt).toBeUndefined();

    nowMs = Date.parse(SEEN_AT);
    fake.setUnpushedWorkResult({ cwd: '/work/project', worktrees: [] });
    await pool.unpushedWork('mgr-gone');

    const worktree = (await lastRescueOf(pool, 'mgr-gone'))?.worktrees[0];
    expect(worktree?.goneAt).toBe(SEEN_AT);
    expect(worktree?.pushed?.ref).toBe('refs/alteroid-rescue/mgr-gone/a-1234abcd');
    await pool.stop();
  });

  it('観測に同じ作業ツリーが在れば、goneAt は付かない', async () => {
    let nowMs = Date.parse(RESCUED_AT);
    const { pool, fake } = await runningSetup('mgr-still', 'inst-A', () => nowMs);
    fake.rescueRef('mgr-still', [rescuedTree]);
    await vi.waitFor(async () => {
      expect((await lastRescueOf(pool, 'mgr-still'))?.worktrees).toHaveLength(1);
    });

    nowMs = Date.parse(SEEN_AT);
    fake.setUnpushedWorkResult({
      cwd: '/work/project',
      worktrees: [{ relativePath: 'work/a', branch: 'feat/a' }],
    });
    await pool.unpushedWork('mgr-still');

    expect((await lastRescueOf(pool, 'mgr-still'))?.worktrees[0]?.goneAt).toBeUndefined();
    await pool.stop();
  });
});
