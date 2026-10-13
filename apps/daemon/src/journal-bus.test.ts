import { createMemoryStores, type JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createJournalBus, JournalStreamQueue, pruneQueuedForDeletion } from './journal-bus.js';

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

describe('/journal/stream の購読者1本ぶんの待ち行列（#4617）', () => {
  async function decisions(count: number, text = 'd'): Promise<JournalEntry[]> {
    const { journal } = createMemoryStores();
    const out: JournalEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(
        await journal.append({ type: 'decision', decision: `${text}${String(i)}`, grounds: 'g' }),
      );
    }
    return out;
  }

  it('積んだ順に取り出し、書き出す data は積んだときの直列化そのもの', async () => {
    const [a, b] = await decisions(2);
    const queue = new JournalStreamQueue();
    queue.push(a as JournalEntry);
    queue.push(b as JournalEntry);

    expect(queue.shift()).toEqual({ entry: a, data: JSON.stringify(a) });
    expect(queue.shift()?.entry.id).toBe(b?.id);
    expect(queue.shift()).toBeUndefined();
    expect(queue.overflow).toBeUndefined();
  });

  it('件数の上限を超えたら、溜めた分を捨てて溢れたことを覚え、以後は積まない', async () => {
    const entries = await decisions(4);
    const queue = new JournalStreamQueue({ maxEntries: 2 });
    for (const entry of entries.slice(0, 3)) queue.push(entry);

    expect(queue.overflow).toEqual({ entries: 3, chars: expect.any(Number) as number });
    expect(queue.shift()).toBeUndefined();
    queue.push(entries[3] as JournalEntry);
    expect(queue.shift()).toBeUndefined();
  });

  it('字数の上限を超えても溢れる。取り出した分は字数から引かれる', async () => {
    const [a, b, c] = await decisions(3, 'x'.repeat(100));
    const one = JSON.stringify(a).length;
    const queue = new JournalStreamQueue({ maxChars: one * 2 });
    queue.push(a as JournalEntry);
    queue.push(b as JournalEntry);
    queue.shift();
    queue.push(c as JournalEntry);
    expect(queue.overflow).toBeUndefined();

    queue.push(a as JournalEntry);
    expect(queue.overflow?.entries).toBe(3);
  });

  it('墓標で捨てた分は字数からも外れる', async () => {
    const { journal } = createMemoryStores();
    const secret = await journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 's'.repeat(100),
      conversationId: 'conv-secret',
    });
    const kept = await journal.append({ type: 'decision', decision: 'k', grounds: 'g' });
    const tombstone = await journal.append({
      type: 'conversation_deleted',
      deletedConversationId: 'conv-secret',
      deletedBy: 'operator',
      hiddenCount: 1,
    });
    if (tombstone.type !== 'conversation_deleted') throw new Error('墓標の形でない');
    const keptChars = JSON.stringify(kept).length;
    const secretChars = JSON.stringify(secret).length;
    // 2本がちょうど入る上限。捨てた分が字数に残っていれば、もう1本の kept で溢れる
    const queue = new JournalStreamQueue({ maxChars: secretChars + keptChars });
    queue.push(secret);
    queue.push(kept);
    queue.pruneForDeletion(tombstone);

    // 捨てた分が字数に残っていれば、ここで溢れる
    queue.push(kept);
    expect(queue.overflow).toBeUndefined();
    expect(queue.shift()?.entry.id).toBe(kept.id);
  });
});
