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
    serializeKey: `conversation:${conversationId}`,
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
        serializeKey: `externalEvent:${eventId}`,
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

  it('検査のあと bind の前に、同時に届いた別の発言が同じ id を同じ会話へ結んでも、断られた回はそれを戻さない（#3282）', async () => {
    const store = createMemoryStores().attachments;
    const a = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const b = await store.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });
    // bind の直前（getMeta で A が未結び付けと見たあと）に割り込む: 別の発言が A を conv-1 へ結び、別の会話が B を取る。
    const racing = new Proxy(store, {
      get(target, key) {
        if (key !== 'bind') {
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (ids: readonly string[], conversationId: string) => {
          expect((await target.bind([a.id], 'conv-1')).bound).toEqual([a.id]);
          expect((await target.bind([b.id], 'conv-2')).bound).toEqual([b.id]);
          return target.bind(ids, conversationId);
        };
      },
    });
    const result = await chatBatch(racing, [a.id, b.id], 'conv-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.code).toBe('attachment_conflict');
    // 先に通った発言が結んだ A は、結ばれたまま残る。
    expect((await store.getMeta(a.id))?.conversationId).toBe('conv-1');
    expect((await store.getMeta(b.id))?.conversationId).toBe('conv-2');
  });
});

describe('checkAndBindAttachments は、同じ宛先への呼びを直列に通す（#3633）', () => {
  it('断る回の戻しが、同じ会話に同時に届いて通った別の発言の添付まで外さない', async () => {
    const real = createMemoryStores().attachments;
    const x = await real.put({ name: 'x.png', mediaType: 'image/png', bytes: PNG });
    const y = await real.put({ name: 'y.png', mediaType: 'image/png', bytes: PNG });

    // 呼び A: [x, y] を conv-1 へ。検査の後、bind の前に y が conv-2 に取られ、bind は x を結んで y で conflict。
    // 戻し（unbind）の直前に、呼び B: [x] を conv-1 へ（x は A が結んだ分なので、B にとっては「結び済み」）が届く。
    // 実時間は待たない。並行の順序はゲートの Promise で決める。
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

    const a = chatBatch(gated, [x.id, y.id], 'conv-1');
    await Promise.resolve();
    expect((await real.bind([y.id], 'conv-2')).bound).toEqual([y.id]);
    releaseBind();
    await reachedUnbind; // A は x を結んで y の conflict で断る途中（戻す直前）
    const b = chatBatch(real, [x.id], 'conv-1');
    // B が（直列化されずに）通れる状態なら、ここまでに終わっている。マクロタスク1つ分だけ譲って流し切る（時間は待たない）。
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseUnbind();
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA.ok).toBe(false);
    expect(resultB.ok).toBe(true);

    // B は通って発言になる。その添付 x は conv-1 に結んだままのはず（外れると、1 時間後の prune で消える）。
    expect((await real.getMeta(x.id))?.conversationId).toBe('conv-1');
  });

  it('先の呼びが例外で落ちても、同じ宛先の次の呼びは通る（鍵が詰まらない）', async () => {
    const real = createMemoryStores().attachments;
    const x = await real.put({ name: 'x.png', mediaType: 'image/png', bytes: PNG });
    const broken = Object.assign(Object.create(real) as AttachmentStore, {
      getMeta: (id: string) => real.getMeta(id),
      bind: () => Promise.reject(new Error('EIO')),
    });
    await expect(chatBatch(broken, [x.id], 'conv-1')).rejects.toThrow('EIO');
    const failing = chatBatch(broken, [x.id], 'conv-1');
    const next = chatBatch(real, [x.id], 'conv-1');
    await expect(failing).rejects.toThrow('EIO');
    expect((await next).ok).toBe(true);
  });
});
