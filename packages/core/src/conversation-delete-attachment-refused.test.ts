import { describe, expect, it, vi } from 'vitest';

import { AttachmentContentRemoveError } from './attachment.js';
import { deleteConversation } from './conversation-delete.js';
import { createMemoryStores } from './testing.js';

// 添付の中身を置き場から消せなかったとき（#4814）: 1件の失敗で残りを止めず、済まなかったことに載せる
describe('deleteConversation: 添付の中身を消せなかった', () => {
  it('消せた添付は消し、消せなかった添付は残り、件数と理由が incomplete に載る', async () => {
    const stores = createMemoryStores();
    const put = (name: string) =>
      stores.attachments.put({
        name,
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode(name),
      });
    const stuck = await put('stuck.txt');
    const fine = await put('fine.txt');
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '添付つき',
      conversationId: 'conv-x',
      attachments: [stuck, fine].map((meta) => ({
        id: meta.id,
        name: meta.name,
        mediaType: meta.mediaType,
        size: meta.size,
        sha256: meta.sha256,
      })),
    });
    const realRemove = stores.attachments.remove.bind(stores.attachments);
    vi.spyOn(stores.attachments, 'remove').mockImplementation(async (id) => {
      if (id === stuck.id) throw new AttachmentContentRemoveError(id, '置き場が落ちている');
      return realRemove(id);
    });

    const result = await deleteConversation(
      { stores, dropQueuedInboxEvents: async () => 0, forgetConversation: () => undefined },
      { conversationId: 'conv-x', deletedBy: 'テスト' },
    );

    expect(result.deleted).toBe(true);
    if (!result.deleted) return;
    expect(result.attachmentsRemoved).toBe(1);
    expect(await stores.attachments.getMeta(fine.id)).toBeUndefined();
    expect(await stores.attachments.getMeta(stuck.id)).toBeDefined();
    expect(result.incomplete).toHaveLength(1);
    expect(result.incomplete[0]).toContain('1 件');
    expect(result.incomplete[0]).toContain('置き場が落ちている');
  });
});
