import { createMemoryStores, createTokenPoolService } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * `POST /chat` の「空の発言」の検査が NUL を落とす前の値で行われ、NUL だけの `text`（添付なし）を
 * 200 で受けていた穴（#3437。#3361 / #3384 / #3388 と同じ形）。
 */
function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
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

describe('POST /chat の text が NUL だけのとき（#3437）', () => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stores = createMemoryStores();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });
  });

  it('NUL だけ（添付なし）なら 400 で断り、日誌へ何も積まない', async () => {
    const res = await app.request('/chat', send({ text: '\u0000' }));
    expect(res.status).toBe(400);
    expect(await stores.journal.list({})).toEqual([]);
  });

  it('NUL が複数並んでいても 400', async () => {
    const res = await app.request('/chat', send({ text: '\u0000\u0000\u0000' }));
    expect(res.status).toBe(400);
  });

  it('400 の文に送られた値を載せない', async () => {
    const res = await app.request('/chat', send({ text: '\u0000' }));
    const raw = await res.text();
    expect(raw).not.toContain('\u0000');
    expect(raw).not.toContain('\\u0000');
  });

  it('従来どおり空文字（添付なし）も 400', async () => {
    const res = await app.request('/chat', send({ text: '' }));
    expect(res.status).toBe(400);
  });

  it('添付があれば NUL だけの本文も text の検査では断らない（添付の検査まで進む）', async () => {
    // 添付 id は実在しないので別の理由で断られる。ここで見るのは「text が空」の文で断られないこと。
    const res = await app.request(
      '/chat',
      send({ text: '\u0000', attachments: ['no-such-attachment'] }),
    );
    const raw = await res.text();
    expect(raw).not.toContain('text が空');
  });

  it('NUL が混じっても中身が残る発言は 200 で受ける', async () => {
    const res = await app.request('/chat', send({ text: 'こん\u0000にちは' }));
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('NUL が混じっても中身が残る発言は text の検査で断らない', async () => {
    const res = await app.request('/chat', send({ text: 'こん\u0000にちは', supersedes: 'x' }));
    // supersedes に conversationId が無いので別の理由（supersedes の検証）で 400 になる。
    // 「text が空」の文でないこと = text の検査を通ったこと。
    const raw = await res.text();
    expect(raw).not.toContain('text が空');
  });
});
