import type { CloneHost, JournalEntry, ManagerSummary } from '@alteroid/core';
import { createMemoryStores, fakeCloneHost, JOURNAL_ENTRY_TYPES } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createJournalBus } from './journal-bus.js';
import {
  JOURNAL_ENTRY_TOPOLOGY_TRIGGER,
  journalEntryMayChangeTopology,
} from './topology-activity.js';
import { topologyResponseSchema } from './openapi.js';

// 地図の流れ（/topology/stream）が日誌の追記で組み直す契機を、地図に効く追記だけに絞った（B1）。
// 絞りは `mapJournalEntry`（活動の記録が日誌から拾う写し）と同じ判定を共有する: 拾わない追記は署名に入らない。

function manager(id: string, status: 'running' | 'waiting_human' = 'running'): ManagerSummary {
  return {
    managerId: id,
    status,
    live: true,
    cwd: '/work',
    request: '実装して',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    waiting: [],
  } as unknown as ManagerSummary;
}

function setup(options: { current: () => ManagerSummary[]; onList?: () => void }) {
  const stores = createMemoryStores();
  const bus = createJournalBus(stores.journal);
  const app = createApp({
    clone: fakeCloneHost({
      usageBlocked: false,
      managers: {
        listWithUnreadable: async () => {
          options.onList?.();
          return { managers: options.current(), unreadable: [] };
        },
      } as unknown as CloneHost['managers'],
    }),
    stores: { ...stores, journal: bus.journal },
    token: 'test-token',
    shutdown: () => undefined,
    journalEvents: bus,
  });
  return { app, journal: bus.journal };
}

function openStream(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const snapshots: unknown[] = [];
  let pending = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
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
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    close: () => reader.cancel(),
  };
}

// 本番の既定（`app-context.ts` の `topologyTickMs`・`topologyDebounceMs`）
const TICK_MS = 2000;
const DEBOUNCE_MS = 200;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('/topology/stream の再計算の契機', () => {
  it('地図に効かない道具の追記（clone の読み取り以外・担当の委譲以外）では組み直さない', async () => {
    let listCalls = 0;
    const { app, journal } = setup({
      current: () => [manager('m1')],
      onList: () => (listCalls += 1),
    });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);

    const before = listCalls;
    for (let i = 0; i < 5; i += 1) {
      await journal.append({ type: 'tool_use', actor: 'clone', tool: 'WebSearch', input: {} });
      await journal.append({ type: 'tool_use', actor: 'manager:m1', tool: 'Bash', input: {} });
      await journal.append({ type: 'tool_use', actor: 'someone-else', tool: 'Read', input: {} });
    }
    await stream.advance(DEBOUNCE_MS * 3);
    expect(listCalls - before).toBe(0);
    expect(stream.snapshots).toHaveLength(1);
    await stream.close();
  });

  it('地図に効く追記は今までどおり 200ms の畳みで 1 回組み直す（作業者の道具・clone の記憶の読み・発言）', async () => {
    let listCalls = 0;
    const { app, journal } = setup({
      current: () => [manager('m1')],
      onList: () => (listCalls += 1),
    });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);

    let before = listCalls;
    await journal.append({ type: 'tool_use', actor: 'worker:m1:worker', tool: 'Edit', input: {} });
    await journal.append({ type: 'tool_use', actor: 'worker:m1:worker', tool: 'Bash', input: {} });
    await stream.advance(DEBOUNCE_MS);
    expect(listCalls - before).toBe(1);
    expect(stream.snapshots).toHaveLength(2);
    expect(
      topologyResponseSchema.parse(stream.snapshots[1]).managers[0]?.workers[0]?.lastTool,
    ).toBe('Bash');

    before = listCalls;
    await journal.append({ type: 'tool_use', actor: 'clone', tool: 'memory_read', input: {} });
    await stream.advance(DEBOUNCE_MS);
    expect(listCalls - before).toBe(1);
    expect(stream.snapshots).toHaveLength(3);

    before = listCalls;
    await journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やって' });
    await stream.advance(DEBOUNCE_MS);
    expect(listCalls - before).toBe(1);
    expect(stream.snapshots).toHaveLength(4);
    await stream.close();
  });

  it('効かない追記だけが続いても、周期（2s）の安全網で署名が変われば送る', async () => {
    let managers = [manager('m1')];
    const { app, journal } = setup({ current: () => managers });
    const stream = openStream(await app.request('/topology/stream'));
    await stream.advance(1);
    expect(stream.snapshots).toHaveLength(1);

    managers = [manager('m1', 'waiting_human')];
    await journal.append({ type: 'tool_use', actor: 'clone', tool: 'WebSearch', input: {} });
    await stream.advance(DEBOUNCE_MS * 3);
    expect(stream.snapshots).toHaveLength(1);

    await stream.advance(TICK_MS);
    expect(stream.snapshots).toHaveLength(2);
    expect(topologyResponseSchema.parse(stream.snapshots[1]).managers[0]?.status).toBe(
      'waiting_human',
    );
    await stream.close();
  });
});

describe('journalEntryMayChangeTopology', () => {
  it('分類の表は日誌の種別と過不足なく一致する（種別が足されたら分類を決めさせる）', () => {
    expect(Object.keys(JOURNAL_ENTRY_TOPOLOGY_TRIGGER).sort()).toEqual(
      [...JOURNAL_ENTRY_TYPES].sort(),
    );
  });

  it('tool_use の他は、どの種別の追記も契機にする（効かないと言い切れないものは効く側）', () => {
    const others = JOURNAL_ENTRY_TYPES.filter((type) => type !== 'tool_use');
    for (const type of others) {
      expect(JOURNAL_ENTRY_TOPOLOGY_TRIGGER[type], type).toBe('always');
      expect(
        journalEntryMayChangeTopology({
          type,
          id: 'x',
          at: new Date().toISOString(),
        } as JournalEntry),
        type,
      ).toBe(true);
    }
  });
});
