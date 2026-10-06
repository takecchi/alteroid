import {
  createMemoryStores,
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentStore,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { checkAndBindAttachments } from './attachment-batch.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** `POST /chat` と同じ束ね方（`apps/daemon/src/app.ts` の `checkAndBindAttachments` 呼び出し）。 */
function chatBatch(store: AttachmentStore, ids: string[], conversationId: string) {
  return checkAndBindAttachments(ids, {
    store,
    limits: DEFAULT_ATTACHMENT_LIMITS,
    bind: (bindIds) => store.bind(bindIds, conversationId),
    unbind: (unbindIds) => store.unbind(unbindIds, { conversationId }),
    isBoundElsewhere: (meta) =>
      meta.conversationId !== undefined && meta.conversationId !== conversationId,
    conflictMessage: '別の会話に結び付いた添付は使えない',
  });
}

describe('checkAndBindAttachments は、400 で断った回に添付を結び付け残さない', () => {
  it('同時に届いた別の会話の発言と B を取り合って conflict で断られた回が、A だけ結び付けて残さない', async () => {
    const store = createMemoryStores().attachments;
    const a = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const b = await store.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });

    // conv-2 が B を取る発言と、conv-1 が [A, B] を取る発言が、同時に届く（どちらも検査を抜けてから結び付ける）。
    const [first, second] = await Promise.all([
      chatBatch(store, [b.id], 'conv-2'),
      chatBatch(store, [a.id, b.id], 'conv-1'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.body.code).toBe('attachment_conflict');

    // 断った（発言は投函されない）のに、A が conv-1 へ結び付いたままだと、A は他の会話へ使えなくなる。
    expect((await store.getMeta(a.id))?.conversationId).toBeUndefined();
    const reuse = await chatBatch(store, [a.id], 'conv-3');
    expect(reuse.ok).toBe(true);
  });

  it('断られた回は、前の発言で同じ会話へ結んだ添付を戻さない（この呼びで新しく結んだ分だけ戻す）', async () => {
    const store = createMemoryStores().attachments;
    const a = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const b = await store.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });
    const c = await store.put({ name: 'c.png', mediaType: 'image/png', bytes: PNG });
    expect((await chatBatch(store, [a.id], 'conv-1')).ok).toBe(true);

    // conv-1 の次の発言が [A, C, B] を取る間に、conv-2 が B を取る。B で断られる。
    const [first, second] = await Promise.all([
      chatBatch(store, [b.id], 'conv-2'),
      chatBatch(store, [a.id, c.id, b.id], 'conv-1'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect((await store.getMeta(a.id))?.conversationId).toBe('conv-1');
    expect((await store.getMeta(c.id))?.conversationId).toBeUndefined();
    expect((await store.getMeta(b.id))?.conversationId).toBe('conv-2');
  });

  it('外部イベントの結び付けでも、取り合いで断られた回が結び付け残さない', async () => {
    const store = createMemoryStores().attachments;
    const a = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const b = await store.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });
    const eventBatch = (ids: string[], eventId: string) =>
      checkAndBindAttachments(ids, {
        store,
        limits: DEFAULT_ATTACHMENT_LIMITS,
        bind: (bindIds) => store.bindToExternalEvent(bindIds, eventId),
        unbind: (unbindIds) => store.unbind(unbindIds, { externalEventId: eventId }),
        isBoundElsewhere: (meta) =>
          meta.conversationId !== undefined || meta.externalEventId !== undefined,
        conflictMessage: 'すでに別の宛先に結び付いた添付は使えない',
      });
    const [first, second] = await Promise.all([
      eventBatch([b.id], 'ev-2'),
      eventBatch([a.id, b.id], 'ev-1'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect((await store.getMeta(a.id))?.externalEventId).toBeUndefined();
    expect((await eventBatch([a.id], 'ev-3')).ok).toBe(true);
  });
});
