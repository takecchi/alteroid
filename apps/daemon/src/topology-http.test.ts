import type { CloneHost, ManagerSummary } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

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

/** SSE を読み、`snapshot` フレームだけを集める。`until` が真になるまで（上限つきで）読む。 */
async function collectSnapshots(
  response: Response,
  until: (snapshots: unknown[]) => boolean,
  limitMs = 3000,
): Promise<{ snapshots: unknown[]; raw: string }> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const snapshots: unknown[] = [];
  let raw = '';
  let pending = '';
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline && !until(snapshots)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 100),
      ),
    ]);
    if (chunk.value === undefined) {
      if (chunk.done && Date.now() >= deadline) break;
      continue;
    }
    const text = decoder.decode(chunk.value, { stream: true });
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
  await reader.cancel();
  return { snapshots, raw };
}

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
    const { app } = setup({ managers: [runningManager('m1')] });
    const response = await app.request('/topology/stream');
    expect(response.status).toBe(200);
    // 周期（40ms）を何回もまたぐ間、読み続ける
    const { snapshots, raw } = await collectSnapshots(response, () => false, 600);
    expect(snapshots).toHaveLength(1);
    expect(topologyResponseSchema.parse(snapshots[0]).managers).toHaveLength(1);
    // heartbeat（コメント行）は流れている＝接続は生きていて、送らなかっただけ
    expect(raw).toContain(': hb');
  });

  it('日誌の追記で内容が変わると、新しいスナップショットが1つ届く', async () => {
    const { app, journal } = setup({ managers: [runningManager('m1')] });
    const response = await app.request('/topology/stream');
    const collecting = collectSnapshots(response, (s) => s.length >= 2, 3000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やって' });
    const { snapshots } = await collecting;
    expect(snapshots).toHaveLength(2);
    expect(topologyResponseSchema.parse(snapshots[0]).links).toEqual([]);
    expect(topologyResponseSchema.parse(snapshots[1]).links.map((l) => l.key)).toEqual([
      'human~clone',
    ]);
  });

  it('日誌の流れが配線されていなくても、周期で動き最初の1回を送る', async () => {
    const { app } = setup({ journal: false });
    const response = await app.request('/topology/stream');
    const { snapshots } = await collectSnapshots(response, (s) => s.length >= 1, 2000);
    expect(snapshots).toHaveLength(1);
    expect(topologyResponseSchema.parse(snapshots[0]).links).toEqual([]);
  });

  it('組めない回があってもストリームは落ちず、次の周期で立ち直る', async () => {
    let failing = true;
    const stores = createMemoryStores();
    const app = createApp({
      clone: {
        usageBlocked: false,
        managers: {
          list: async () => {
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
    const response = await app.request('/topology/stream');
    const collecting = collectSnapshots(response, (s) => s.length >= 1, 2000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    failing = false;
    const { snapshots } = await collecting;
    expect(snapshots).toHaveLength(1);
  });
});
