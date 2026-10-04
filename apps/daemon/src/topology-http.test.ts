import type { CloneHost, ManagerSummary } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createJournalBus } from './journal-bus.js';
import { topologyResponseSchema } from './openapi.js';

/** 稼働の地図が読む面だけを持つクローン。**`activeTurn` は実装しない**（unknown を見るため）。 */
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
  options: { journal?: boolean; managers?: ManagerSummary[]; clone?: Partial<CloneHost> } = {},
) {
  const stores = createMemoryStores();
  const bus = createJournalBus(stores.journal);
  const app = createApp({
    clone: fakeCloneFor(options.managers ?? [], options.clone),
    stores: { ...stores, journal: bus.journal },
    token: 'test-token',
    shutdown: () => undefined,
    ...(options.journal === false ? {} : { journalEvents: bus }),
    topologyTickMs: 40,
    topologyDebounceMs: 5,
    sseHeartbeatMs: 20,
  });
  return { app, journal: bus.journal };
}

/**
 * SSE を背景で読み、`snapshot` フレームと生の本文を集める。
 *
 * **実時間で待たない。** 周期（`topologyTickMs`）・待ち（`topologyDebounceMs`）・heartbeat は
 * 偽の時計で進める（`advance`）。「再送しない」のような**起きないこと**も、時計を進めて
 * 周期が何回も回ったこと（`listCalls`）を測ったうえで見る。
 */
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
    /** 偽の時計を進める（書き込みが読み手へ届くまでの microtask も流す）。 */
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    close: () => reader.cancel(),
  };
}

beforeEach(() => {
  // `Date` も偽にする（結果の使い回し `maxAgeMs` が時計を読むため）。
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
    expect(body.clone).toEqual({ state: 'unknown' }); // activeTurn 未実装
    expect(body.storage.state).toBe('unknown'); // storageProbe 未配線
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
    // 呼ぶたびに組み直すと startedAt が動いて「変わった」ことになる。固定の1本を返す。
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

    // 周期（40ms）を何十周もさせる。**回ったこと**を数えたうえで、再送が無いことを見る。
    const before = listCalls;
    // 周期の再計算は1秒の間は直近の結果を使い回すので、それを超えるまで進める。
    await stream.advance(1600);
    expect(listCalls).toBeGreaterThan(before);
    expect(stream.snapshots).toHaveLength(1);
    // heartbeat（コメント行）は流れている＝接続は生きていて、送らなかっただけ
    expect(stream.raw()).toContain(': hb');
    await stream.close();
  });

  it('日誌の追記で内容が変わると、新しいスナップショットが1つ届く', async () => {
    const { app, journal } = setup({ managers: [runningManager('m1')] });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);

    await journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やって' });
    await stream.advance(20); // 待ち（5ms）の後に組み直される
    expect(stream.snapshots).toHaveLength(2);
    expect(topologyResponseSchema.parse(stream.snapshots[0]).links).toEqual([]);
    expect(topologyResponseSchema.parse(stream.snapshots[1]).links.map((l) => l.key)).toEqual([
      'human~clone',
    ]);
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
    // 失敗の回が周期ごとに回っている（落ちていない）が、送るものは無い
    expect(listCalls).toBeGreaterThan(1);
    expect(stream.snapshots).toHaveLength(0);

    failing = false;
    await stream.advance(40);
    expect(stream.snapshots).toHaveLength(1);
    await stream.close();
  });
});
