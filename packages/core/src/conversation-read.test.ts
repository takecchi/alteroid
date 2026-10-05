import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  countUnreadConversations,
  loadConversationReadView,
  verifyConversationReadStoreContract,
} from './conversation-read.js';
import { collectConversations, countUnread, effectiveReadThrough } from './conversation.js';
import type { Exchange } from './conversation.js';
import type { ConversationReadView } from './conversation-read.js';
import type { JournalEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

function exchange(overrides: Partial<Exchange> & Pick<Exchange, 'id' | 'at'>): Exchange {
  return {
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: '本文',
    conversationId: 'c1',
    ...overrides,
  };
}

const view = (
  baseline: string | null,
  positions: Record<string, string> = {},
): ConversationReadView => ({
  baseline,
  positions: Object.fromEntries(
    Object.entries(positions).map(([id, readThrough]) => [
      id,
      { readThrough, updatedAt: readThrough },
    ]),
  ),
});

describe('ConversationReadStore（インメモリ）', () => {
  it('器の契約（3実装で同じことを測る）', async () => {
    await verifyConversationReadStoreContract(createMemoryStores().conversationReads);
  });
});

describe('loadConversationReadView', () => {
  it('基準時刻が無ければ渡した時刻で決め、2度目は変えない', async () => {
    const { conversationReads } = createMemoryStores();
    const first = await loadConversationReadView(conversationReads, '2026-10-01T00:00:00.000Z');
    const second = await loadConversationReadView(conversationReads, '2026-10-02T00:00:00.000Z');
    expect(first.baseline).toBe('2026-10-01T00:00:00.000Z');
    expect(second.baseline).toBe('2026-10-01T00:00:00.000Z');
  });

  it('読めない器は unreadable を載せ、位置は無いものとして返す', async () => {
    const { conversationReads } = createMemoryStores();
    const broken = {
      ...conversationReads,
      read: async () => ({ state: 'unreadable' as const, reason: '壊れている' }),
      ensureBaseline: async () => ({ state: 'unreadable' as const, reason: '壊れている' }),
    };
    expect(await loadConversationReadView(broken, '2026-10-01T00:00:00.000Z')).toEqual({
      baseline: null,
      positions: {},
      unreadable: '壊れている',
    });
  });
});

describe('countUnread / effectiveReadThrough / collectConversations', () => {
  const base = '2026-10-01T00:00:00.000Z';

  it('数えるのは outbound だけ。人間自身の発言（inbound）は未読にしない', () => {
    const messages = [
      { role: 'inbound' as const, at: '2026-10-01T00:00:01.000Z' },
      { role: 'outbound' as const, at: '2026-10-01T00:00:02.000Z' },
      { role: 'outbound' as const, at: '2026-10-01T00:00:03.000Z' },
    ];
    expect(countUnread(messages, base)).toBe(2);
    expect(countUnread(messages, '2026-10-01T00:00:02.000Z')).toBe(1);
    // 同時刻は既読
    expect(countUnread(messages, '2026-10-01T00:00:03.000Z')).toBe(0);
    // 位置が全く無いときは全件
    expect(countUnread(messages, null)).toBe(2);
  });

  it('実効位置は位置と基準時刻の遅いほう（基準時刻が床）。位置が無ければ基準時刻、基準時刻が無ければ位置', () => {
    const v = view(base, { c1: '2026-10-02T00:00:00.000Z', c2: '2026-09-01T00:00:00.000Z' });
    expect(effectiveReadThrough(v, 'c1')).toBe('2026-10-02T00:00:00.000Z');
    expect(effectiveReadThrough(v, 'c2')).toBe(base);
    expect(effectiveReadThrough(view(null, { c1: '2026-09-01T00:00:00.000Z' }), 'c1')).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(effectiveReadThrough(v, 'other')).toBe(base);
    expect(effectiveReadThrough(view(null), 'other')).toBeNull();
  });

  const entries: JournalEntry[] = [
    exchange({ id: 'n3', at: '2026-10-03T00:00:00.000Z', conversationId: 'new', role: 'outbound' }),
    exchange({ id: 'o2', at: '2026-09-30T00:00:02.000Z', conversationId: 'old', role: 'outbound' }),
    exchange({ id: 'o1', at: '2026-09-30T00:00:01.000Z', conversationId: 'old' }),
  ];

  it('記録の無い会話は基準時刻で判定する（前の古い会話は0、後の新しい会話は未読）', () => {
    const summaries = collectConversations(entries, view(base));
    expect(summaries.find((s) => s.conversationId === 'old')).toMatchObject({
      unread: 0,
      readThrough: base,
    });
    expect(summaries.find((s) => s.conversationId === 'new')).toMatchObject({ unread: 1 });
  });

  it('位置が基準時刻より前でも基準時刻が床になる（古い発言を指しても間の返答は未読に戻らない）', () => {
    const summaries = collectConversations(
      entries,
      view(base, { old: '2026-09-30T00:00:01.000Z' }),
    );
    expect(summaries.find((s) => s.conversationId === 'old')).toMatchObject({
      unread: 0,
      readThrough: base,
    });
  });

  it('編集で隠れた outbound は数えない', () => {
    const edited: JournalEntry[] = [
      exchange({ id: 'r2', at: '2026-10-05T00:00:04.000Z', role: 'outbound' }),
      exchange({ id: 'h2', at: '2026-10-05T00:00:03.000Z', supersedes: 'h1' }),
      exchange({ id: 'r1', at: '2026-10-05T00:00:02.000Z', role: 'outbound' }),
      exchange({ id: 'h1', at: '2026-10-05T00:00:01.000Z' }),
    ];
    // r1 は h1 とともに隠れる。見えている outbound は r2 だけ。
    expect(collectConversations(edited, view(base))[0]).toMatchObject({ unread: 1 });
  });

  it('既読の記録を渡さない要約は、位置が無いものとして数える（readThrough は null）', () => {
    expect(collectConversations(entries).find((s) => s.conversationId === 'old')).toMatchObject({
      unread: 1,
      readThrough: null,
    });
  });
});

describe('countUnreadConversations', () => {
  const T = (s: number) =>
    new Date(Date.parse('2026-10-01T00:00:00.000Z') + s * 1000).toISOString();

  afterEach(() => {
    vi.useRealTimers();
  });

  async function backlog(n: number) {
    const stores = createMemoryStores();
    await stores.conversationReads.ensureBaseline(T(0));
    // 同じ時刻の発言だけで chunk が埋まると先へ進めないので、1件ずつ時刻をずらす。
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < n; i += 1) {
      vi.setSystemTime(Date.parse(T(1 + i)));
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'outbound',
        text: 'x',
        conversationId: `c${i}`,
      });
    }
    return {
      stores,
      deps: { journal: stores.journal, reads: stores.conversationReads, now: T(1000) },
    };
  }

  it('溜まりが1回の上限の何倍あっても、呼び出しを重ねれば capped が外れて正しい数に収束する', async () => {
    const { deps } = await backlog(12);
    const options = { chunk: 2, maxChunks: 1 };
    const first = await countUnreadConversations(deps, options);
    expect(first.capped).toBe(true);
    let last = first;
    let calls = 1;
    while (last.capped && calls < 30) {
      last = await countUnreadConversations(deps, options);
      calls += 1;
    }
    expect(last).toEqual({ count: 12, capped: false });
    // 前進している（同じ所を読み直し続けない）
    expect(calls).toBeLessThan(30);
  });

  it('並行2本の取り込みでも印は戻らず、数は正しい', async () => {
    const { stores, deps } = await backlog(8);
    const options = { chunk: 3, maxChunks: 1 };
    await Promise.all([
      countUnreadConversations(deps, options),
      countUnreadConversations(deps, options),
    ]);
    const mid = await stores.conversationReads.readOutboundIndex();
    await Promise.all([
      countUnreadConversations(deps, options),
      countUnreadConversations(deps, options),
    ]);
    const after = await stores.conversationReads.readOutboundIndex();
    if (mid.state !== 'ok' || after.state !== 'ok') throw new Error('読めない');
    expect(Date.parse(after.watermark ?? '')).toBeGreaterThanOrEqual(
      Date.parse(mid.watermark ?? ''),
    );
    const last = await countUnreadConversations(deps, { chunk: 3, maxChunks: 10 });
    expect(last).toEqual({ count: 8, capped: false });
  });

  it('索引を消すと（リセット後）、消えた会話を数えない', async () => {
    const stores = createMemoryStores();
    await stores.conversationReads.ensureBaseline(T(0));
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: 'x',
      conversationId: 'c',
    });
    const deps = { journal: stores.journal, reads: stores.conversationReads, now: T(1000) };
    expect((await countUnreadConversations(deps)).count).toBe(1);
    await stores.journal.clear();
    await stores.conversationReads.clearOutboundIndex();
    expect((await countUnreadConversations(deps)).count).toBe(0);
  });
});
