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

async function bootWith(stores: Stores, mirrorAppendRetryDelaysMs: readonly number[]) {
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
    mirrorAppendRetryDelaysMs,
  });
  await pool.restore();
  return { fake, pool };
}

describe('生ログの写しの預けが落ちても、やり直して抜けを作らない（#4657）', () => {
  it('⭐ 預けが2回落ちても3回目で預け、後の塊はその後に順番どおり預ける', async () => {
    const appended: string[] = [];
    let failures = 0;
    const stores: Stores = {
      ...createMemoryStores(),
      sessionStore: {
        append: async (_key, entries) => {
          const uuid = String((entries[0] as { uuid?: string }).uuid);
          if (uuid === 'first' && failures < 2) {
            failures += 1;
            throw new Error(`Connection terminated unexpectedly（${String(failures)} 回目）`);
          }
          appended.push(uuid);
        },
        load: async () => null,
      },
    };
    const { fake, pool } = await bootWith(stores, [10, 10]);
    try {
      fake.emit(mirror('first'));
      fake.emit(mirror('second'));
      await vi.waitFor(() => expect(appended).toEqual(['first', 'second']), WAIT);
      expect(failures).toBe(2);
    } finally {
      await pool.stop();
    }
  });

  it('やり直し切れなかったら、日誌に「欠けたまま戻る」を残し、後の塊は預ける', async () => {
    const appended: string[] = [];
    let attempts = 0;
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      sessionStore: {
        append: async (_key, entries) => {
          const uuid = String((entries[0] as { uuid?: string }).uuid);
          if (uuid === 'first') {
            attempts += 1;
            throw new Error('Connection terminated unexpectedly');
          }
          appended.push(uuid);
        },
        load: async () => null,
      },
    };
    const { fake, pool } = await bootWith(stores, [10]);
    try {
      fake.emit(mirror('first'));
      fake.emit(mirror('second'));
      await vi.waitFor(() => expect(appended).toEqual(['second']), WAIT);
      expect(attempts).toBe(2);
      await vi.waitFor(async () => {
        const rows = await base.journal.list({ types: ['exchange'] });
        expect(
          rows.some(
            (row) =>
              row.type === 'exchange' &&
              row.text.includes('PG へ預けられなかった') &&
              row.text.includes('欠けたまま戻る'),
          ),
        ).toBe(true);
      }, WAIT);
    } finally {
      await pool.stop();
    }
  });
});
