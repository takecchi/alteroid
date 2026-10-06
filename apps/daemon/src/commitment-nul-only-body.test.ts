import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * HTTP の commitments の口（`POST /commitments`・`PATCH /commitments/:id`）も、NUL だけの本文を
 * 断る（Issue #3388。道具 `commitment_open` / `commitment_edit` と同じ）。台帳の入口は本文から NUL を
 * 落として残すので、検査が生の値の長さ（`z.string().min(1)`）だと、NUL だけの本文が空の本文になる。
 */
function setup() {
  const stores = createMemoryStores();
  const clone: CloneHost = {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
  const send = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify(body),
    });
  return { stores, send };
}

describe('commitments の HTTP の口と NUL だけの本文', () => {
  it('POST /commitments は NUL だけの body を 400 で断り、行を作らない', async () => {
    const { stores, send } = setup();
    const response = await send('POST', '/commitments', { body: '\u0000' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('\u0000');
    expect((await stores.commitments.list()).entries).toEqual([]);
  });

  it('PATCH /commitments/:id は NUL だけの body を 400 で断り、元の本文を残す', async () => {
    const { stores, send } = setup();
    await stores.commitments.open({
      id: 'c-1',
      at: '2026-10-06T00:00:00.000Z',
      origin: 'human',
      body: '元の本文',
    });
    const response = await send('PATCH', '/commitments/c-1', { body: '\u0000\u0000' });
    expect(response.status).toBe(400);
    expect((await stores.commitments.get('c-1'))?.body).toBe('元の本文');
  });

  it('NUL が混じっても、落とした後に本文が残るなら今までどおり保存できる', async () => {
    const { stores, send } = setup();
    const opened = await send('POST', '/commitments', { body: '\u0000宿題' });
    expect(opened.status).toBe(200);
    const { id } = (await opened.json()) as { id: string };
    expect((await stores.commitments.get(id))?.body).toBe('宿題');

    const edited = await send('PATCH', `/commitments/${id}`, { body: '直\u0000した' });
    expect(edited.status).toBe(200);
    expect((await stores.commitments.get(id))?.body).toBe('直した');
  });
});
