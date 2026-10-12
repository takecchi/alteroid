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

// runner が `/managers` で名乗った「分類器の拒否が上限を越えた相手」が、名簿の観測を通って manager_list の材料（ManagerSummary）に載る。

const job: Job = {
  id: 'mgr-over',
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  status: 'running',
  summary: '設計書',
  request: '設計書を直して',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-a',
};

function fakeRunner(denials: RunnerManagerState['classifierDenials']): RunnerClient {
  const state: RunnerManagerState = {
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: job.request ?? '',
    waiting: [],
    sessionId: 'sess-1',
    ...(denials === undefined ? {} : { classifierDenials: denials }),
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

async function listWith(denials: RunnerManagerState['classifierDenials']) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T00:00:00.000Z'));
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const registry = createRunnerRegistry([]);
  await registry.register({ label: 'http://runner:4518', open: async () => fakeRunner(denials) });
  const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
  await pool.restore();
  // 名簿の探り（10秒ごと）で `/managers` を聞かせる
  await vi.advanceTimersByTimeAsync(10_000);
  const [summary] = (await pool.list()).filter((entry) => entry.managerId === job.id);
  await pool.stop();
  await registry.stop();
  return summary;
}

describe('ManagerSummary.classifierDenials', () => {
  it('runner が名乗った上限越えの相手を、そのまま載せる', async () => {
    const summary = await listWith([
      { actor: 'manager', consecutive: 3, total: 4, firstReason: '[Git Destructive]' },
    ]);
    expect(summary?.classifierDenials).toEqual([
      { actor: 'manager', consecutive: 3, total: 4, firstReason: '[Git Destructive]' },
    ]);
  });

  it('空配列は空配列のまま、名乗らない古い runner の委譲には欄を作らない', async () => {
    expect((await listWith([]))?.classifierDenials).toEqual([]);
    expect(await listWith(undefined)).not.toHaveProperty('classifierDenials');
  });
});
