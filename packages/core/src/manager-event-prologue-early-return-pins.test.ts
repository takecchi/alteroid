import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  RUNNER_CAPABILITY_MANAGER_PEERS,
  type RunnerClient,
  type RunnerEntry,
  type RunnerEvent,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Pool#handleEvent` の入口（`switch (event.type)` より前）の早い return のうち、既存の試験が縛っていなかったものを、
// 外から見える結果（`pool.runnerHasCapability` 等の公開の読み口・日誌・受信箱・runner の登録簿への問い合わせ）だけで縛る。
// 段（非公開メソッド）へ分けるときに早い return を取り違えると落ちる。
//   - hello / anthropic_route / manager_peers: 止めた後に届いた名乗りは、前の名乗りを書き換えない（`if (this.#stopped) return;`）
//   - codex_auth: codex の同期を持たないプールは、runner を取りに行かず何もしない
//   - 台帳に無い担当の出来事: 後ろの case へ落とさず、何も書かず、投げない
// 縛らないもの（外しても外から見て同じ振る舞いになる）:
//   - shutting_down / hello / anthropic_route / manager_peers / scratch_sweep / codex_auth 末尾の `return;`:
//     外して後ろへ落ちても、これらの出来事に managerId が無く、台帳に無い担当（上の最後の枝）と同じ扱いで何も起きない。
// 「何も起きない」ことは、結果が先に現れてから macrotask を2周流して見る（マイクロタスクの数には頼らない）。

const CLOCK = Date.parse('2026-09-01T00:00:00.000Z');

function fakeRunner(runnerId: string): {
  client: RunnerClient;
  emit: (event: RunnerEvent) => void;
} {
  const holder: { emit?: (event: RunnerEvent) => void } = {};
  return {
    emit: (event) => {
      if (holder.emit === undefined) throw new Error('まだ接続されていない');
      holder.emit(event);
    },
    client: fakeRunnerClient({
      runnerId,
      async connect(onEvent) {
        holder.emit = onEvent;
      },
    }),
  };
}

function entryOf(runnerId: string): RunnerEntry {
  return {
    label: runnerId,
    state: 'connected',
    runnerId,
    since: '2026-08-01T00:00:00.000Z',
    revision: { status: 'unheard' },
  };
}

interface Env {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  emit: (event: RunnerEvent) => void;
  /** 登録簿の `get` が、`build` の後に受けた runnerId。 */
  getCalls: string[];
}

async function build(): Promise<Env> {
  const stores = createMemoryStores();
  const fake = fakeRunner('runner-a');
  const getCalls: string[] = [];
  const registry = fakeRunnerRegistry({
    async list() {
      return [fake.client];
    },
    async get(runnerId) {
      getCalls.push(runnerId);
      return runnerId === 'runner-a' ? fake.client : null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
    async register() {
      /* この検証では使わない。 */
    },
    async unregister() {
      /* この検証では使わない。 */
    },
    vacate() {
      /* この検証では使わない。 */
    },
    entries() {
      return [entryOf('runner-a')];
    },
    noteManagerFailed() {
      /* この検証では使わない。 */
    },
    subscribe() {
      return () => {};
    },
    async stop() {},
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => CLOCK,
  });
  // 存在しない managerId の abort で connect だけを踏ませる: pool に SSE を張らせる経路がこれしか無く、張らないと emit が得られないため。
  await pool.abort('mgr-does-not-exist');
  getCalls.length = 0;
  return { pool, stores, inbox, emit: fake.emit, getCalls };
}

/** 非同期の続きを macrotask 2周ぶん流しきる（メモリの台帳・日誌は実時間を使わない）。 */
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('止めた後に届いた runner の名乗りは、前の名乗りを書き換えない', () => {
  it('hello: 止めた後の hello は、能力・モデル・経路の名乗りを置き換えない', async () => {
    const env = await build();

    env.emit({
      type: 'hello',
      runnerId: 'runner-a',
      capabilities: ['cap-before'],
      managerModel: 'model-before',
      anthropicRoute: ['ROUTE_BEFORE'],
    });
    await vi.waitFor(() => {
      if (env.pool.runnerHasCapability?.('runner-a', 'cap-before') !== true) {
        throw new Error('止める前の hello がまだ反映されていない');
      }
    });
    await env.pool.stop();

    env.emit({
      type: 'hello',
      runnerId: 'runner-a',
      capabilities: ['cap-after'],
      managerModel: 'model-after',
      anthropicRoute: ['ROUTE_AFTER'],
    });
    await drain();

    // 早い return を外すと、能力は `cap-after` だけに置き換わり、モデルと経路も新しい名乗りになる。
    expect(env.pool.runnerHasCapability?.('runner-a', 'cap-before')).toBe(true);
    expect(env.pool.runnerHasCapability?.('runner-a', 'cap-after')).toBe(false);
    expect(env.pool.runnerReportedModels?.('runner-a')).toEqual({ manager: 'model-before' });
    expect(env.pool.runnerReportedAnthropicRoute?.('runner-a')).toEqual(['ROUTE_BEFORE']);
  });

  it('anthropic_route: 止めた後の anthropic_route は、経路の名乗りを置き換えない', async () => {
    const env = await build();

    env.emit({ type: 'anthropic_route', runnerId: 'runner-a', anthropicRoute: ['ROUTE_BEFORE'] });
    await vi.waitFor(() => {
      if (env.pool.runnerReportedAnthropicRoute?.('runner-a') === undefined) {
        throw new Error('止める前の anthropic_route がまだ反映されていない');
      }
    });
    await env.pool.stop();

    env.emit({ type: 'anthropic_route', runnerId: 'runner-a', anthropicRoute: ['ROUTE_AFTER'] });
    await drain();

    expect(env.pool.runnerReportedAnthropicRoute?.('runner-a')).toEqual(['ROUTE_BEFORE']);
  });

  it('manager_peers: 止めた後の manager_peers は、peer の名乗りを置き換えない', async () => {
    const env = await build();

    env.emit({
      type: 'hello',
      runnerId: 'runner-a',
      capabilities: [RUNNER_CAPABILITY_MANAGER_PEERS],
      managerPeers: [{ provider: 'codex' }],
    });
    await vi.waitFor(() => {
      const peers = env.pool.managerPeersOf?.('runner-a');
      if (peers?.status !== 'named') throw new Error('止める前の hello がまだ反映されていない');
    });
    await env.pool.stop();

    env.emit({
      type: 'manager_peers',
      runnerId: 'runner-a',
      managerPeers: [{ provider: 'other' }],
    });
    await drain();

    expect(env.pool.managerPeersOf?.('runner-a')).toEqual({
      status: 'named',
      peers: [{ provider: 'codex' }],
    });
  });
});

describe('codex_auth: codex の同期を持たないプール', () => {
  it('何もせず、runner を取りに行かない（登録簿への問い合わせも日誌も受信箱も動かない）', async () => {
    const env = await build();

    env.emit({
      type: 'codex_auth',
      runnerId: 'runner-a',
      kind: 'changed',
      baseRevision: 'rev-1',
      fingerprint: 'fp-1',
    });
    await drain();

    // 早い return を外すと、同期へ渡す前に登録簿から runner を引く。
    expect(env.getCalls).toEqual([]);
    expect(await env.stores.journal.list({})).toEqual([]);
    expect(env.inbox).toEqual([]);
    await env.pool.stop();
  });
});

describe('台帳に無い担当の出来事', () => {
  it('後ろの case へ落とさない（投げず、日誌にも受信箱にも何も残さない）', async () => {
    const env = await build();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      env.emit({ type: 'tool_end', managerId: 'mgr-unknown', toolUseId: 'tu-1' });
      await drain();

      // 早い return を外すと、record が無いまま後ろへ進んで TypeError で投げる。
      expect(unhandled).toEqual([]);
      expect(await env.stores.journal.list({})).toEqual([]);
      expect(env.inbox).toEqual([]);
      expect(await env.pool.list()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    await env.pool.stop();
  });
});
