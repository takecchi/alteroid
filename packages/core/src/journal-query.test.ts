import { describe, expect, it } from 'vitest';

import {
  addJournalTombstone,
  emptyJournalTombstones,
  isHiddenJournalEntry,
  journalTombstonesOf,
  matchesJournalQuery,
} from './journal-query.js';
import { journalEntrySchema } from './schema.js';
import type { JournalEntry } from './schema.js';

function exchange(
  id: string,
  at: string,
  extra: { conversationId?: string; with?: 'human' | 'manager' | 'self'; text?: string } = {},
): JournalEntry {
  return journalEntrySchema.parse({
    type: 'exchange',
    id,
    at,
    with: extra.with ?? 'human',
    role: 'inbound',
    text: extra.text ?? 'hello',
    ...(extra.conversationId === undefined ? {} : { conversationId: extra.conversationId }),
  });
}

function toolUse(id: string, at: string): JournalEntry {
  return journalEntrySchema.parse({
    type: 'tool_use',
    id,
    at,
    actor: 'clone',
    tool: 'journal_read',
  });
}

function tombstone(
  id: string,
  deletedConversationId: string,
  hiddenEntryIds?: string[],
): Extract<JournalEntry, { type: 'conversation_deleted' }> {
  const entry = journalEntrySchema.parse({
    type: 'conversation_deleted',
    id,
    at: '2026-01-01T00:00:00.000Z',
    deletedConversationId,
    deletedBy: 'operator',
    hiddenCount: 0,
    ...(hiddenEntryIds === undefined ? {} : { hiddenEntryIds }),
  });
  if (entry.type !== 'conversation_deleted') throw new Error('unreachable');
  return entry;
}

describe('isHiddenJournalEntry（隠す行の判定。pg の hiddenConversationExchangeExcluded と同じ意味）', () => {
  it('墓標が無ければ何も隠さない', () => {
    const tombstones = emptyJournalTombstones();
    expect(
      isHiddenJournalEntry(
        exchange('a', '2026-01-01T00:00:00.000Z', { conversationId: 'c1' }),
        tombstones,
      ),
    ).toBe(false);
    expect(isHiddenJournalEntry(toolUse('t', '2026-01-01T00:00:00.000Z'), tombstones)).toBe(false);
  });

  it('消した会話の exchange は隠す／別の会話・会話 id の無い exchange は隠さない', () => {
    const tombstones = emptyJournalTombstones();
    addJournalTombstone(tombstones, tombstone('d', 'c1'));
    expect(
      isHiddenJournalEntry(
        exchange('a', '2026-01-01T00:00:00.000Z', { conversationId: 'c1' }),
        tombstones,
      ),
    ).toBe(true);
    expect(
      isHiddenJournalEntry(
        exchange('b', '2026-01-01T00:00:00.000Z', { conversationId: 'c2' }),
        tombstones,
      ),
    ).toBe(false);
    expect(isHiddenJournalEntry(exchange('c', '2026-01-01T00:00:00.000Z'), tombstones)).toBe(false);
  });

  it('墓標が名指しした行は種別・会話 id によらず隠す／名指ししていない行は隠さない', () => {
    const tombstones = emptyJournalTombstones();
    addJournalTombstone(tombstones, tombstone('d', 'c1', ['named']));
    expect(isHiddenJournalEntry(toolUse('named', '2026-01-01T00:00:00.000Z'), tombstones)).toBe(
      true,
    );
    expect(isHiddenJournalEntry(exchange('named', '2026-01-01T00:00:00.000Z'), tombstones)).toBe(
      true,
    );
    expect(isHiddenJournalEntry(toolUse('other', '2026-01-01T00:00:00.000Z'), tombstones)).toBe(
      false,
    );
  });

  it('墓標の行そのものは隠さない（会話 id の欄を持たない）', () => {
    const own = tombstone('d', 'c1');
    expect(isHiddenJournalEntry(own, journalTombstonesOf([own]))).toBe(false);
  });

  it('journalTombstonesOf は積んだ行から導く（墓標を取り除いた列からは消える）', () => {
    const del = tombstone('d', 'c1', ['x']);
    const kept = exchange('a', '2026-01-01T00:00:00.000Z', { conversationId: 'c1' });
    expect(isHiddenJournalEntry(kept, journalTombstonesOf([kept, del]))).toBe(true);
    expect(isHiddenJournalEntry(kept, journalTombstonesOf([kept]))).toBe(false);
  });
});

describe('matchesJournalQuery（list の行ごとの絞り込み。隠す行・after・order・limit は含まない）', () => {
  const at = '2026-03-10T12:00:00.000Z';

  it('条件が無ければ全部通す', () => {
    expect(matchesJournalQuery(exchange('a', at), {})).toBe(true);
    expect(matchesJournalQuery(toolUse('t', at), {})).toBe(true);
  });

  it('types: 含む種別だけ通す／空配列は0件', () => {
    expect(matchesJournalQuery(toolUse('t', at), { types: ['tool_use'] })).toBe(true);
    expect(matchesJournalQuery(exchange('a', at), { types: ['tool_use'] })).toBe(false);
    expect(matchesJournalQuery(exchange('a', at), { types: [] })).toBe(false);
  });

  it('with: exchange の相手だけで通す／exchange でない行は落とす／空配列は0件', () => {
    expect(matchesJournalQuery(exchange('a', at, { with: 'manager' }), { with: ['manager'] })).toBe(
      true,
    );
    expect(matchesJournalQuery(exchange('a', at, { with: 'human' }), { with: ['manager'] })).toBe(
      false,
    );
    expect(matchesJournalQuery(toolUse('t', at), { with: ['manager', 'human', 'self'] })).toBe(
      false,
    );
    expect(matchesJournalQuery(exchange('a', at), { with: [] })).toBe(false);
  });

  it('conversationId: 一致する行だけ通す／会話 id の欄を持たない行は落とす', () => {
    expect(
      matchesJournalQuery(exchange('a', at, { conversationId: 'c1' }), { conversationId: 'c1' }),
    ).toBe(true);
    expect(
      matchesJournalQuery(exchange('a', at, { conversationId: 'c2' }), { conversationId: 'c1' }),
    ).toBe(false);
    expect(matchesJournalQuery(exchange('a', at), { conversationId: 'c1' })).toBe(false);
    expect(matchesJournalQuery(toolUse('t', at), { conversationId: 'c1' })).toBe(false);
  });

  it('q: 本文の照合は matchesJournalSearch に任せる（大文字小文字を畳む部分一致）', () => {
    expect(matchesJournalQuery(exchange('a', at, { text: 'Hello World' }), { q: 'hello' })).toBe(
      true,
    );
    expect(matchesJournalQuery(exchange('a', at, { text: 'Hello World' }), { q: 'zzz' })).toBe(
      false,
    );
  });

  it('since / until: 両端を含む／空文字は絞らない（fs の元の書き方）', () => {
    expect(matchesJournalQuery(exchange('a', at), { since: at })).toBe(true);
    expect(matchesJournalQuery(exchange('a', at), { since: '2026-03-10T12:00:00.001Z' })).toBe(
      false,
    );
    expect(matchesJournalQuery(exchange('a', at), { until: at })).toBe(true);
    expect(matchesJournalQuery(exchange('a', at), { until: '2026-03-10T11:59:59.999Z' })).toBe(
      false,
    );
    expect(matchesJournalQuery(exchange('a', at), { since: '', until: '' })).toBe(true);
  });

  it('条件は AND で効く', () => {
    const entry = exchange('a', at, { conversationId: 'c1', with: 'human', text: 'abc' });
    expect(
      matchesJournalQuery(entry, {
        types: ['exchange'],
        with: ['human'],
        conversationId: 'c1',
        q: 'abc',
        since: '2026-03-10T00:00:00.000Z',
        until: '2026-03-11T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      matchesJournalQuery(entry, { types: ['exchange'], with: ['human'], conversationId: 'c2' }),
    ).toBe(false);
  });
});
