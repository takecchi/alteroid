import { describe, expect, it } from 'vitest';

import {
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

  it('実効位置は会話の位置があればそれ、無ければ基準時刻', () => {
    const v = view(base, { c1: '2026-10-02T00:00:00.000Z' });
    expect(effectiveReadThrough(v, 'c1')).toBe('2026-10-02T00:00:00.000Z');
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

  it('会話の位置が基準時刻より優先される（位置が基準より前でも位置で判定）', () => {
    const summaries = collectConversations(
      entries,
      view(base, { old: '2026-09-30T00:00:01.000Z' }),
    );
    expect(summaries.find((s) => s.conversationId === 'old')).toMatchObject({ unread: 1 });
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
