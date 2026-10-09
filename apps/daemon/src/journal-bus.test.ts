import { createMemoryStores, type JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createJournalBus, pruneQueuedForDeletion } from './journal-bus.js';

describe('溜めた行から、墓標が外す行を捨てる（#4379）', () => {
  it('消した会話の exchange と、墓標が名指しした行を捨て、ほかの行は順序のまま残す', async () => {
    const { journal } = createMemoryStores();
    const secret = await journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '秘密',
      conversationId: 'conv-secret',
    });
    const copy = await journal.append({ type: 'decision', decision: '写し', grounds: 'g' });
    const kept = await journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '残す',
      conversationId: 'conv-keep',
    });
    const other = await journal.append({ type: 'decision', decision: '別の判断', grounds: 'g' });
    const tombstone = await journal.append({
      type: 'conversation_deleted',
      deletedConversationId: 'conv-secret',
      deletedBy: 'operator',
      hiddenCount: 1,
      hiddenEntryIds: [copy.id],
    });
    if (tombstone.type !== 'conversation_deleted') throw new Error('墓標の形でない');

    const queue = [secret, copy, kept, other];
    pruneQueuedForDeletion(queue, tombstone);

    expect(queue.map((entry) => entry.id)).toEqual([kept.id, other.id]);
  });
});

describe('日誌の購読（journal-bus）', () => {
  it('積んだ行を、積んだ順に流す', async () => {
    const bus = createJournalBus(createMemoryStores().journal);
    const seen: JournalEntry[] = [];
    bus.subscribe((entry) => seen.push(entry));

    const first = await bus.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '1',
      conversationId: 'conv-1',
    });
    const second = await bus.journal.append({ type: 'decision', decision: '2', grounds: 'g' });

    expect(seen.map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it('削除した会話の発言は、削除の後に積まれても流さない。墓標とほかの会話は流す（#4218）', async () => {
    const bus = createJournalBus(createMemoryStores().journal);
    await bus.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '秘密',
      conversationId: 'conv-secret',
    });
    const seen: JournalEntry[] = [];
    bus.subscribe((entry) => seen.push(entry));

    const tombstone = await bus.journal.append({
      type: 'conversation_deleted',
      deletedConversationId: 'conv-secret',
      deletedBy: 'operator',
      hiddenCount: 1,
    });
    await bus.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '消した後に書かれた返答（秘密を含みうる）',
      conversationId: 'conv-secret',
    });
    const kept = await bus.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '残す',
      conversationId: 'conv-keep',
    });

    expect(seen.map((entry) => entry.id)).toEqual([tombstone.id, kept.id]);
  });
});
