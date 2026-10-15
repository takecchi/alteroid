import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// runner が `/managers` で名乗った「確認待ちの peer の本数と最古の待ち始め」が、名簿の観測を通って manager_list の材料（ManagerSummary）に載る（#4886）。

const job: Job = {
  id: 'mgr-peer',
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  status: 'running',
  summary: '設計書',
  request: '設計書を直して',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-a',
};

function fakeRunner(pending: RunnerManagerState['pendingPeerApprovals']): RunnerClient {
  const state: RunnerManagerState = {
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: job.request ?? '',
    waiting: [],
    sessionId: 'sess-1',
    ...(pending === undefined ? {} : { pendingPeerApprovals: pending }),
  };
  return {
    runnerId: 'runner-a',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {
      /* 出来事は流さない */
    },
    async ping() {
      /* 生きている */
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
      /* 使わない */
    },
    async list() {
      return [state];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      /* 使わない */
    },
    async close() {
      /* 使わない */
    },
  } as unknown as RunnerClient;
}

afterEach(() => {
  vi.useRealTimers();
});

async function listWith(pending: RunnerManagerState['pendingPeerApprovals']) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T00:00:00.000Z'));
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const registry = createRunnerRegistry([]);
  await registry.register({ label: 'http://runner:4518', open: async () => fakeRunner(pending) });
  const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
  await pool.restore();
  // 名簿の探り（10秒ごと）で `/managers` を聞かせる
  await vi.advanceTimersByTimeAsync(10_000);
  const [summary] = (await pool.list()).filter((entry) => entry.managerId === job.id);
  await pool.stop();
  await registry.stop();
  return summary;
}

describe('ManagerSummary.pendingPeerApprovals', () => {
  it('runner が名乗った確認待ちの本数と最古の待ち始めを載せる', async () => {
    const summary = await listWith({ count: 2, oldestSince: '2026-10-11T23:40:00.000Z' });
    expect(summary?.pendingPeerApprovals).toEqual({
      count: 2,
      oldestSince: '2026-10-11T23:40:00.000Z',
    });
  });

  it('待っているものが無い（欄が無い）委譲には欄を作らない', async () => {
    expect(await listWith(undefined)).not.toHaveProperty('pendingPeerApprovals');
  });
});
