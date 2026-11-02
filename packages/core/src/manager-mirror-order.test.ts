import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
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
          liveBackgroundTasks: 0,
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

describe('並べるのは同じ生ログの預けだけで、別の生ログの預けは待たせない（#4485）', () => {
  // 先に届いた預けを止めたまま、別の鍵の預けが進むか。止まる鍵は `first`、動く鍵は `other`
  async function appendsWhileFirstHeld(
    firstKey: { projectKey: string; sessionId: string; subpath?: string },
    otherKey: { projectKey: string; sessionId: string; subpath?: string },
  ) {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const stores: Stores = {
      ...createMemoryStores(),
      sessionStore: {
        append: async (_key, entries) => {
          const uuid = String((entries[0] as { uuid?: string }).uuid);
          started.push(uuid);
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
    const { fake, pool } = await bootWith(stores);
    try {
      fake.emit({ ...mirror('first'), key: firstKey } as RunnerEvent);
      fake.emit({ ...mirror('other'), key: otherKey } as RunnerEvent);
      // 別の鍵は、先の預けが終わっていなくても進む
      // 並べてしまう実装では永久に来ないので、試験の上限より手前で落とす
      await vi.waitFor(() => expect(finished).toEqual(['other']), { timeout: 2_000 });
      expect(started).toEqual(['first', 'other']);
    } finally {
      releaseFirst?.();
      await pool.stop();
    }
  }

  it('sessionId が違えば並べない', async () => {
    await appendsWhileFirstHeld(
      { projectKey: 'proj-key', sessionId: 'sess-a' },
      { projectKey: 'proj-key', sessionId: 'sess-b' },
    );
  });

  it('subpath が違えば並べない（同じセッションの別の生ログ）', async () => {
    await appendsWhileFirstHeld(
      { projectKey: 'proj-key', sessionId: 'sess-a' },
      { projectKey: 'proj-key', sessionId: 'sess-a', subpath: 'subagents/agent-1' },
    );
  });

  it('projectKey が違えば並べない', async () => {
    await appendsWhileFirstHeld(
      { projectKey: 'proj-key', sessionId: 'sess-a' },
      { projectKey: 'other-key', sessionId: 'sess-a' },
    );
  });
});

/** 預けのやり直しの待ち（既定の 1 秒・5 秒・30 秒）。試験は偽の時計でこの値のまま進める。 */
const MIRROR_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

async function bootWith(stores: Stores) {
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
  return { fake, pool };
}

describe('生ログの写しの預けが落ちても、やり直して抜けを作らない（#4657）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
    const { fake, pool } = await bootWith(stores);
    try {
      fake.emit(mirror('first'));
      fake.emit(mirror('second'));
      // 1回目の失敗の後は 1 秒、2回目の失敗の後は 5 秒置く。その手前では次を始めない
      await vi.advanceTimersByTimeAsync(MIRROR_RETRY_DELAYS_MS[0] - 1);
      expect(failures).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(failures).toBe(2);
      await vi.advanceTimersByTimeAsync(MIRROR_RETRY_DELAYS_MS[1] - 1);
      expect(appended).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(appended).toEqual(['first', 'second']);
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
    const { fake, pool } = await bootWith(stores);
    try {
      fake.emit(mirror('first'));
      fake.emit(mirror('second'));
      // 既定は3回やり直す（計4回試す）。全部の待ちを進めきるまでは、後の塊は預けない
      const total = MIRROR_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
      await vi.advanceTimersByTimeAsync(total - 1);
      expect(appended).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(appended).toEqual(['second']), WAIT);
      expect(attempts).toBe(MIRROR_RETRY_DELAYS_MS.length + 1);
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
