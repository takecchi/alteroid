import { createMemoryStores, createTokenPoolService } from '@alteroid/core';
import type { CloneHost, InboxEvent, Stores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6, 5]);

let outcome: 'persisted' | 'unavailable' | 'throws' = 'persisted';
let posted: InboxEvent[] = [];

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async (event: InboxEvent) => {
      if (outcome === 'unavailable') return 'unavailable';
      if (outcome === 'throws') throw new Error('inbox write blew up (test)');
      posted.push(event);
      return 'persisted';
    },
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

const send = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// open を見たら読むのをやめる: open の後の流れはターンの終わりまで閉じないため。open なしで閉じたら最後まで読んだ本文を返す
async function readUntilOpen(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
    if (text.includes('event: open')) {
      await reader.cancel();
      return text;
    }
  }
}

describe('POST /chat の新しい会話で受信箱へ書けなかったら、結んだ添付を戻す（#4759）', () => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    outcome = 'persisted';
    posted = [];
    stores = createMemoryStores();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });
  });

  for (const failure of ['unavailable', 'throws'] as const) {
    it(`⭐ ${failure}: 送り直し（同じ clientMessageId・会話 id なし）が attachment_conflict にならず、新しい会話で受け取られる`, async () => {
      const meta = await stores.attachments.put({
        name: 'a.png',
        mediaType: 'image/png',
        bytes: PNG,
        uploadedBy: 'operator',
      });
      const body = { text: '画像を見て', attachments: [meta.id], clientMessageId: 'cm-1' };

      outcome = failure;
      const first = await app.request('/chat', send(body));
      // 投げた回は 500 か、流れの中で閉じる。どちらでも open は出ない
      expect(await readUntilOpen(first)).not.toContain('event: open');
      expect((await stores.attachments.getMeta(meta.id))?.conversationId).toBeUndefined();

      outcome = 'persisted';
      const second = await app.request('/chat', send(body));
      expect(second.status).toBe(200);
      expect(await readUntilOpen(second)).toContain('event: open');
      expect(posted).toHaveLength(1);
      const conversationId = (posted[0] as { conversationId: string }).conversationId;
      expect((await stores.attachments.getMeta(meta.id))?.conversationId).toBe(conversationId);
    });
  }

  it('対照: 既存の会話へ送って書けなかったときは、添付をその会話に結んだままにする（送り直しも同じ会話に結び直すだけ）', async () => {
    const meta = await stores.attachments.put({
      name: 'a.png',
      mediaType: 'image/png',
      bytes: PNG,
      uploadedBy: 'operator',
    });
    const started = await app.request('/chat', send({ text: '始める', clientMessageId: 'cm-0' }));
    await readUntilOpen(started);
    const conversationId = (posted[0] as { conversationId: string }).conversationId;

    outcome = 'unavailable';
    const first = await app.request(
      '/chat',
      send({ text: '画像を見て', conversationId, attachments: [meta.id], clientMessageId: 'cm-1' }),
    );
    expect(await readUntilOpen(first)).not.toContain('event: open');
    expect((await stores.attachments.getMeta(meta.id))?.conversationId).toBe(conversationId);
  });
});
