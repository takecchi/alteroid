import type { CloneHost, ManagerSummary } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createJournalBus } from './journal-bus.js';
import { createWorkerToolBus } from './topology-activity.js';
import { topologyResponseSchema } from './openapi.js';

function fakeCloneFor(managers: ManagerSummary[], overrides: Partial<CloneHost> = {}) {
  return {
    usageBlocked: false,
    managers: { list: async () => managers },
    ...overrides,
  } as unknown as CloneHost;
}

function runningManager(id: string): ManagerSummary {
  return {
    managerId: id,
    status: 'running',
    live: true,
    cwd: '/work',
    request: '実装して',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    waiting: [],
  } as unknown as ManagerSummary;
}

function setup(
  options: {
    journal?: boolean;
    managers?: ManagerSummary[];
    clone?: Partial<CloneHost>;
    unreadable?: { id?: string; reason: string }[];
  } = {},
) {
  const stores = createMemoryStores();
  if (options.unreadable !== undefined) {
    const rows = options.unreadable;
    stores.jobs = { ...stores.jobs, listUnreadableJobs: async () => rows };
  }
  const bus = createJournalBus(stores.journal);
  const workerTools = createWorkerToolBus();
  const app = createApp({
    workerToolEvents: workerTools,
    clone: fakeCloneFor(options.managers ?? [], options.clone),
    stores: { ...stores, journal: bus.journal },
    token: 'test-token',
    shutdown: () => undefined,
    ...(options.journal === false ? {} : { journalEvents: bus }),
    topologyTickMs: 40,
    topologyDebounceMs: 5,
    sseHeartbeatMs: 20,
  });
  return { app, journal: bus.journal, workerTools };
}

function openStream(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const snapshots: unknown[] = [];
  let raw = '';
  let pending = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      pending += text;
      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (frame.includes('event: snapshot')) {
          const data = frame.split('\n').find((line) => line.startsWith('data:'));
          if (data !== undefined) snapshots.push(JSON.parse(data.slice(5)));
        }
        boundary = pending.indexOf('\n\n');
      }
    }
  })();
  return {
    snapshots,
    raw: () => raw,
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    close: () => reader.cancel(),
  };
}

beforeEach(() => {
  // `Date` も偽にする: 結果の使い回し `maxAgeMs` が時計を読むため。
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GET /topology', () => {
  it('応答のスキーマを通り、配線されていない軸は unknown になる', async () => {
    const { app } = setup({ managers: [runningManager('m1')] });
    const response = await app.request('/topology');
    expect(response.status).toBe(200);
    const body = topologyResponseSchema.parse(await response.json());
    expect(body.clone).toEqual({ state: 'unknown' });
    expect(body.storage.state).toBe('unknown');
    expect(body.runners).toEqual([]);
    expect(body.managers.map((m) => m.managerId)).toEqual(['m1']);
    expect(body.links).toEqual([]);
  });

  it('activeTurn があれば busy / idle を答える', async () => {
    const busy = setup({ clone: { activeTurn: () => ({ conversationId: 'c1', kind: 'normal' }) } });
    expect(
      ((await (await busy.app.request('/topology')).json()) as { clone: unknown }).clone,
    ).toEqual({
      state: 'busy',
      turn: { conversationId: 'c1', kind: 'normal' },
    });
    const idle = setup({ clone: { activeTurn: () => null } });
    expect(
      ((await (await idle.app.request('/topology')).json()) as { clone: unknown }).clone,
    ).toEqual({
      state: 'idle',
    });
  });

  it('日誌に載った出来事が線の時刻になる', async () => {
    const { app, journal } = setup({ managers: [runningManager('m1')] });
    await journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やって' });
    await journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: '[m1] 実装して',
      managerId: 'm1',
    });
    const body = topologyResponseSchema.parse(await (await app.request('/topology')).json());
    const keys = body.links.map((link) => link.key).sort();
    expect(keys).toEqual(['clone~manager:m1', 'human~clone']);
    expect(body.links.find((l) => l.key === 'human~clone')?.lastDownAt).toBeDefined();
    expect(body.links.find((l) => l.key === 'clone~manager:m1')?.lastUpAt).toBeUndefined();
  });

  it('日誌の external_event は via 付きでも外部サービスの線にしない（受け付けた時刻で入れる。#3676）', async () => {
    const { app, journal } = setup();
    await journal.append({ type: 'external_event', source: 'internal', summary: '{}' });
    await journal.append({
      type: 'external_event',
      source: 'github',
      summary: '{}',
      via: { keyId: 'k1', name: 'GitHub 連携' },
    });
    const body = topologyResponseSchema.parse(await (await app.request('/topology')).json());
    expect(body.externals).toBeUndefined();
    expect(body.links).toEqual([]);
  });

  it('台帳に読めない委譲の行が在れば、managers が空でも unreadable が載る。無ければ鍵ごと無い（#2705）', async () => {
    const rows = [{ id: 'mgr-bad', reason: '不正な欄: status' }];
    const broken = setup({ managers: [], unreadable: rows });
    const body = topologyResponseSchema.parse(await (await broken.app.request('/topology')).json());
    expect(body.managers).toEqual([]);
    expect(body.unreadable).toEqual(rows);

    const healthy = setup({ managers: [] });
    const raw = (await (await healthy.app.request('/topology')).json()) as Record<string, unknown>;
    expect('unreadable' in raw).toBe(false);
  });

  it('日誌の流れが配線されていなくても応える（線は空）', async () => {
    const { app } = setup({ journal: false, managers: [runningManager('m1')] });
    const body = topologyResponseSchema.parse(await (await app.request('/topology')).json());
    expect(body.links).toEqual([]);
    expect(body.managers).toHaveLength(1);
  });
});

describe('GET /topology/stream', () => {
  it('開いたとき1回送り、内容が変わらない間は再送しない', async () => {
    let listCalls = 0;
    const fixed = runningManager('m1');
    const { app } = setup({
      clone: {
        managers: {
          list: async () => {
            listCalls += 1;
            return [fixed];
          },
        },
      } as unknown as Partial<CloneHost>,
    });
    const response = await app.request('/topology/stream');
    expect(response.status).toBe(200);
    const stream = openStream(response);
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);
    expect(topologyResponseSchema.parse(stream.snapshots[0]).managers).toHaveLength(1);

    const before = listCalls;
    await stream.advance(1600);
    expect(listCalls).toBeGreaterThan(before);
    expect(stream.snapshots).toHaveLength(1);
    expect(stream.raw()).toContain(': hb');
    await stream.close();
  });

  it('日誌の追記で内容が変わると、新しいスナップショットが1つ届く', async () => {
    const { app, journal } = setup({ managers: [runningManager('m1')] });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);

    await journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やって' });
    await stream.advance(20);
    expect(stream.snapshots).toHaveLength(2);
    expect(topologyResponseSchema.parse(stream.snapshots[0]).links).toEqual([]);
    expect(topologyResponseSchema.parse(stream.snapshots[1]).links.map((l) => l.key)).toEqual([
      'human~clone',
    ]);
    await stream.close();
  });

  it('作業者の道具の実行中の合図で内容が変わると、日誌の追記なしで新しいスナップショットが届く（#2725）', async () => {
    const { app, workerTools } = setup({ managers: [runningManager('m1')] });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);

    const startedAt = new Date(Date.now() - 90_000).toISOString();
    workerTools.emit({
      type: 'tool_running',
      managerId: 'm1',
      actor: 'worker:m1:worker',
      tool: 'Bash',
      toolUseId: 'tu-1',
      startedAt,
    });
    await stream.advance(20);
    expect(stream.snapshots).toHaveLength(2);
    expect(
      topologyResponseSchema.parse(stream.snapshots[1]).managers[0]?.workers[0]?.runningTool,
    ).toEqual({ tool: 'Bash', startedAt });

    workerTools.emit({ type: 'tool_end', managerId: 'm1', toolUseId: 'tu-1' });
    await stream.advance(20);
    expect(stream.snapshots).toHaveLength(3);
    expect(topologyResponseSchema.parse(stream.snapshots[2]).managers[0]?.workers).toEqual([]);
    await stream.close();
  });

  it('スナップショットにも unreadable が載る（#2705）', async () => {
    const rows = [{ id: 'mgr-bad', reason: '不正な欄: status' }];
    const { app } = setup({ unreadable: rows });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);
    expect(topologyResponseSchema.parse(stream.snapshots[0]).unreadable).toEqual(rows);
    await stream.close();
  });

  it('日誌の流れが配線されていなくても、周期で動き最初の1回を送る', async () => {
    const { app } = setup({ journal: false });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);
    expect(topologyResponseSchema.parse(stream.snapshots[0]).links).toEqual([]);
    await stream.close();
  });

  it('組めない回があってもストリームは落ちず、次の周期で立ち直る', async () => {
    let failing = true;
    let listCalls = 0;
    const stores = createMemoryStores();
    const app = createApp({
      clone: {
        usageBlocked: false,
        managers: {
          list: async () => {
            listCalls += 1;
            if (failing) throw new Error('boom');
            return [];
          },
        },
      } as unknown as CloneHost,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      topologyTickMs: 30,
      sseHeartbeatMs: 20,
    });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(100);
    expect(listCalls).toBeGreaterThan(1);
    expect(stream.snapshots).toHaveLength(0);
    expect(stream.raw().match(/event: unavailable/g)).toHaveLength(1);
    expect(stream.raw()).toContain('"error":"Error"');
    expect(stream.raw()).not.toContain('boom');

    failing = false;
    await stream.advance(40);
    expect(stream.snapshots).toHaveLength(1);
    await stream.close();
  });

  it('2つのクライアントが同じ日誌の連続を受けても、台帳を読む回数は窓ごとに高々1回', async () => {
    let listCalls = 0;
    const fixed = runningManager('m1');
    const { app, journal } = setup({
      clone: {
        managers: {
          list: async () => {
            listCalls += 1;
            return [fixed];
          },
        },
      } as unknown as Partial<CloneHost>,
    });
    const a = openStream(await app.request('/topology/stream'));
    const b = openStream(await app.request('/topology/stream'));
    await a.advance(20);
    expect(a.snapshots).toHaveLength(1);
    expect(b.snapshots).toHaveLength(1);

    const before = listCalls;
    for (let i = 0; i < 5; i += 1) {
      await journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `発言${String(i)}`,
      });
    }
    await a.advance(20);
    expect(listCalls - before).toBe(1);
    expect(a.snapshots).toHaveLength(2);
    expect(b.snapshots).toHaveLength(2);
    await a.close();
    await b.close();
  });

  it('storageProbe は createApp の時点で聞き始める（待たない）', async () => {
    const probe = vi.fn(async () => undefined);
    createApp({
      clone: fakeCloneFor([]),
      stores: createMemoryStores(),
      token: 'test-token',
      shutdown: () => undefined,
      storage: 'PostgreSQL（host/db）',
      storageProbe: probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
