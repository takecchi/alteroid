import { describe, expect, it } from 'vitest';

import { createManagerPool, type WorkerToolEvent } from './manager.js';
import type {
  RunnerClient,
  RunnerEntry,
  RunnerEvent,
  RunnerRegistry,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 作業者の道具の実行中の合図（`tool_running` / `tool_end`、Issue #2725）が、
 * **日誌に1行も書かれず**、コールバックへだけ渡ることを確かめる。
 */
describe('ManagerPool#onEvent: tool_running / tool_end', () => {
  async function setup(withCallback: boolean) {
    const stores = createMemoryStores();
    const job: Job = {
      id: 'mgr-1',
      managerId: 'mgr-1',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running',
      summary: '走行中の委譲',
      request: '続きをやって',
      cwd: '/work/project',
      runnerId: 'runner-a',
    };
    await stores.jobs.putJob(job);
    let emit: ((event: RunnerEvent) => void) | undefined;
    const client = {
      runnerId: 'runner-a',
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect(onEvent: (event: RunnerEvent) => void) {
        emit = onEvent;
      },
      async list() {
        return [];
      },
      async close() {},
    } as unknown as RunnerClient;
    const entry: RunnerEntry = {
      label: 'runner-a',
      state: 'connected',
      runnerId: 'runner-a',
      since: '2026-08-01T00:00:00.000Z',
      revision: { status: 'unheard' },
    };
    const registry = {
      async list() {
        return [client];
      },
      async get() {
        return client;
      },
      entries: () => [entry],
      subscribe: () => () => {},
    } as unknown as RunnerRegistry;
    const received: WorkerToolEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: registry,
      ...(withCallback ? { onWorkerToolEvent: (event: WorkerToolEvent) => received.push(event) } : {}),
    });
    await pool.abort('mgr-does-not-exist'); // 接続を開く
    return { stores, emit: () => emit, received };
  }

  const running: RunnerEvent = {
    type: 'tool_running',
    managerId: 'mgr-1',
    actor: 'worker:mgr-1:worker',
    tool: 'Bash',
    toolUseId: 'tu-1',
    startedAt: '2026-10-04T00:00:00.000Z',
  };
  const end: RunnerEvent = { type: 'tool_end', managerId: 'mgr-1', toolUseId: 'tu-1' };

  it('コールバックへ渡し、日誌には1行も書かない', async () => {
    const { stores, emit, received } = await setup(true);
    const before = (await stores.journal.list()).length;
    emit()?.(running);
    emit()?.(end);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([running, end]);
    expect((await stores.journal.list()).length).toBe(before);
  });

  it('コールバックが無くても落ちず、日誌にも書かない', async () => {
    const { stores, emit } = await setup(false);
    expect(emit()).toBeDefined();
    const before = (await stores.journal.list()).length;
    emit()?.(running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await stores.journal.list()).length).toBe(before);
  });
});
