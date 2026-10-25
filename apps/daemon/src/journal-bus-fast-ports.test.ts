import { createMemoryStores, type CloneHost, type JournalStore } from '@alteroid/core';
import { PgJournalStore } from '@alteroid/storage-pg';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createJournalBus } from './journal-bus.js';

// 口の名前を手で並べない: 並べた名前しか確かめず、器に足した口を包みが落としても赤くならないため（#5089・#5140 で足した速い口が、それで本番の経路から全部落ちていた）
function pgJournalPortNames(): string[] {
  const proto = PgJournalStore.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter(
    (name) =>
      name !== 'constructor' &&
      typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function',
  );
}

describe('日誌の購読の包みは、器の口を落とさない（#5140）', () => {
  it('pg の器が持つ口は、append の他も全部、包みを通しても同じ口へ同じ引数で届く', () => {
    const names = pgJournalPortNames();
    // 数え方が速い口を拾えていることを先に確かめる: 拾えていなければ、下の確かめは何も縛らない
    expect(names).toEqual(
      expect.arrayContaining([
        'conversationWindowHeads',
        'exchangeTextHeads',
        'withdrawnClientMessageIds',
        'conversationIdsAfter',
        'humanReplies',
      ]),
    );
    const calls: [string, unknown[]][] = [];
    const inner = Object.fromEntries(
      names.map((name) => [
        name,
        (...args: unknown[]) => {
          calls.push([name, args]);
          return `answer:${name}`;
        },
      ]),
    ) as unknown as JournalStore;
    const { journal } = createJournalBus(inner);

    const forwarded = names.filter((name) => name !== 'append');
    for (const name of forwarded) {
      const port = (journal as unknown as Record<string, unknown>)[name];
      expect(typeof port, name).toBe('function');
      expect((port as (arg: unknown) => unknown)({ probe: name }), name).toBe(`answer:${name}`);
    }
    expect(calls).toEqual(forwarded.map((name) => [name, [{ probe: name }]]));
  });

  it('中身が持たない任意の口は、包んでも持たない（呼び手が器の口の有無を見て、別の読み方へ倒せる）', () => {
    const { journal } = createJournalBus(createMemoryStores().journal);

    expect(journal.conversationWindowHeads).toBeUndefined();
    expect('conversationWindowHeads' in journal).toBe(false);
    expect(journal.humanReplies).toBeUndefined();
  });

  it('GET /conversations と GET /conversations/unread-count は、包みを通しても器の速い口で読む', async () => {
    const base = createMemoryStores();
    const conversationWindowHeads = vi.fn(() => Promise.resolve({ rows: [], next: null }));
    const exchangeTextHeads = vi.fn(() => Promise.resolve([]));
    const humanReplies = vi.fn(() => Promise.resolve([]));
    const inner: JournalStore = {
      ...base.journal,
      conversationWindowHeads,
      exchangeTextHeads,
      humanReplies,
    };
    const bus = createJournalBus(inner);
    const app = createApp({
      clone: {} as unknown as CloneHost,
      stores: { ...base, journal: bus.journal },
      token: 'test-token',
      shutdown: () => undefined,
      journalEvents: bus,
    });

    const list = await app.request('/conversations?limit=30');
    expect(list.status).toBe(200);
    expect(conversationWindowHeads).toHaveBeenCalledTimes(1);

    const unread = await app.request('/conversations/unread-count');
    expect(unread.status).toBe(200);
    expect(humanReplies).toHaveBeenCalledTimes(1);
  });
});
