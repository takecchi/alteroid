import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

const WAIT = { timeout: 10_000 };

function fakeRunner() {
  let onEvent: ((event: RunnerEvent) => void) | undefined;
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(listener) {
      onEvent = listener;
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
      return [
        {
          managerId: 'mgr-a',
          status: 'running' as const,
          cwd: '/work/mgr-a',
          request: '調べて',
          waiting: [],
          sessionId: 'sess-a',
        },
      ];
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
      /* 使わない */
    },
  };
  return {
    runner,
    emit: (event: RunnerEvent) => {
      if (onEvent === undefined) throw new Error('connect() がまだ呼ばれていない');
      onEvent(event);
    },
  };
}

function mirror(uuid: string): RunnerEvent {
  return {
    type: 'mirror',
    managerId: 'mgr-a',
    key: { projectKey: 'proj-key', sessionId: 'sess-a' },
    entries: [{ type: 'user', uuid }],
  };
}

describe('同じ生ログへの mirror の預けは、届いた順に1つずつ行う（#4485）', () => {
  it('先の預けが終わるまで後の預けを始めず、生ログの行の順を入れ替えない', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const stores: Stores = {
      ...createMemoryStores(),
      sessionStore: {
        append: async (_key, entries) => {
          const uuid = String((entries[0] as { uuid?: string }).uuid);
          started.push(uuid);
          // 先に届いた預けだけ遅らせる（大きい書き出しを pg へ送っている間を作る）
          if (uuid === 'first') {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          finished.push(uuid);
        },
        load: async () => null,
      },
    };
    await stores.jobs.putJob({
      id: 'mgr-a',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '調べ物',
      request: '調べて',
      cwd: '/work/mgr-a',
      sessionId: 'sess-a',
      runnerId: 'runner-primary',
      projectKey: 'proj-key',
    });
    const fake = fakeRunner();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
    });
    await pool.restore();

    fake.emit(mirror('first'));
    fake.emit(mirror('second'));

    await vi.waitFor(() => expect(started).toContain('first'), WAIT);
    // 先の預けが終わっていない間は、後の預けを始めない
    await Promise.resolve();
    expect(started).toEqual(['first']);

    releaseFirst?.();
    await vi.waitFor(() => expect(finished).toEqual(['first', 'second']), WAIT);
    expect(started).toEqual(['first', 'second']);
  });
});
