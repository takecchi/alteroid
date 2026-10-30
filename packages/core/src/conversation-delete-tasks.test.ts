import { describe, expect, it } from 'vitest';

import { deleteConversation } from './conversation-delete.js';
import { createMemoryStores } from './testing.js';

const SECRET = 'sk-secret-5899';
const NOW = '2026-10-08T10:00:00.000Z';

// 会話を消しても、その会話から開いた Task が残っていた（#5899）。Task の本文には人間の発言の全文が入る
describe('deleteConversation: Task', () => {
  it('その会話を起点とする Task（未了・閉じた・クローンが立てた・移行前の形）を消し、件数を返す。ほかの会話の Task は残る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: `鍵は ${SECRET}`,
      conversationId: 'conv-x',
    });
    const add = (id: string, origin: 'human' | 'self', extra: Record<string, string>) =>
      stores.tasks.add({
        id,
        createdAt: NOW,
        updatedAt: NOW,
        status: 'queued',
        origin,
        title: id,
        body: `鍵は ${SECRET}`,
        ...extra,
      });
    await add('t-open', 'human', { source: 'conv-x', originConversationId: 'conv-x' });
    await add('t-closed', 'human', { source: 'conv-x', originConversationId: 'conv-x' });
    await stores.tasks.setStatus('t-closed', 'done', { by: 'clone', at: NOW });
    await add('t-self', 'self', { originConversationId: 'conv-x' });
    await add('t-migrated', 'human', { source: 'conv-x' });
    await add('t-keep', 'human', { source: 'conv-keep', originConversationId: 'conv-keep' });

    const result = await deleteConversation(
      { stores, dropQueuedInboxEvents: async () => 0, forgetConversation: () => undefined },
      { conversationId: 'conv-x', deletedBy: 'テスト' },
    );

    expect(result.deleted).toBe(true);
    if (!result.deleted) return;
    expect(result.tasksRemoved).toBe(4);
    expect(result.incomplete).toEqual([]);
    const left = (await stores.tasks.list({ includeClosed: true })).entries.map((task) => task.id);
    expect(left).toEqual(['t-keep']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('Task を消せなかったら、会話は外れたまま incomplete に名前が載り、件数は 0 になる', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 'こんにちは',
      conversationId: 'conv-x',
    });
    stores.tasks.removeForConversation = async () => {
      throw new Error('器が落ちている');
    };

    const result = await deleteConversation(
      { stores, dropQueuedInboxEvents: async () => 0, forgetConversation: () => undefined },
      { conversationId: 'conv-x', deletedBy: 'テスト' },
    );

    expect(result.deleted).toBe(true);
    if (!result.deleted) return;
    expect(result.tasksRemoved).toBe(0);
    expect(result.incomplete).toHaveLength(1);
    expect(result.incomplete[0]).toContain('Task');
    expect(result.incomplete[0]).toContain('器が落ちている');
  });
});
