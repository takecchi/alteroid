import {
  checkAndBindOutboundAttachments,
  createMemoryStores,
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentStore,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { checkAndBindAttachments } from './attachment-batch.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// 人間の発言（daemon の POST /chat）の経路
function humanChat(store: AttachmentStore, ids: string[], conversationId: string) {
  return checkAndBindAttachments(ids, {
    store,
    limits: DEFAULT_ATTACHMENT_LIMITS,
    bind: (bindIds) => store.bind(bindIds, conversationId),
    unbind: (unbindIds) => store.unbind(unbindIds, { conversationId }),
    isBoundElsewhere: (meta) =>
      meta.conversationId !== undefined && meta.conversationId !== conversationId,
    conflictMessage: '別の会話に結び付いた添付は使えない',
    serializeKey: `conversation:${conversationId}`,
  });
}

// クローンの発言（core の task_say / reply_attach）の経路
function cloneSay(store: AttachmentStore, ids: string[], conversationId: string) {
  return checkAndBindOutboundAttachments({ attachments: store }, ids, {
    conversationId,
    limits: DEFAULT_ATTACHMENT_LIMITS,
  });
}

// #5676: 2つの経路の直列化が別々だと、同じ会話への呼びが互いを待たない
describe('添付の結び付けは、人間の発言とクローンの発言をまたいでも同じ会話への呼びを直列に通す（#5676）', () => {
  it('人間の発言が断られて戻す間に、同じ会話へ同じ添付を指したクローンの発言が通っても、その添付は外れない', async () => {
    const real = createMemoryStores().attachments;
    const x = await real.put({ name: 'x.png', mediaType: 'image/png', bytes: PNG });
    const y = await real.put({ name: 'y.png', mediaType: 'image/png', bytes: PNG });

    let releaseBind!: () => void;
    let releaseUnbind!: () => void;
    let unbindReached!: () => void;
    const bindGate = new Promise<void>((resolve) => (releaseBind = resolve));
    const unbindGate = new Promise<void>((resolve) => (releaseUnbind = resolve));
    const reachedUnbind = new Promise<void>((resolve) => (unbindReached = resolve));
    const gated: AttachmentStore = Object.assign(Object.create(real) as AttachmentStore, {
      getMeta: (id: string) => real.getMeta(id),
      bind: async (ids: readonly string[], conversationId: string) => {
        await bindGate;
        return real.bind(ids, conversationId);
      },
      unbind: async (ids: readonly string[], target: Parameters<AttachmentStore['unbind']>[1]) => {
        unbindReached();
        await unbindGate;
        return real.unbind(ids, target);
      },
    });

    // 人間の発言 A: x を conv-1 へ新しく結ぶが、y が別の会話に取られていて断られ、x を戻す
    const a = humanChat(gated, [x.id, y.id], 'conv-1');
    await Promise.resolve();
    expect((await real.bind([y.id], 'conv-2')).bound).toEqual([y.id]);
    releaseBind();
    await reachedUnbind;
    // A が x を戻す前に、クローンの発言 B が同じ会話へ x を指す
    const b = cloneSay(real, [x.id], 'conv-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseUnbind();
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA.ok).toBe(false);
    expect(resultB.ok).toBe(true);

    // B が通した発言の添付 x は、A の戻しで外れていない
    expect((await real.getMeta(x.id))?.conversationId).toBe('conv-1');
  });
});
