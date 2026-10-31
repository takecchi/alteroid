import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

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
  return { stores, app, send };
}

// 台帳の撤去の段2b: 人間の側から台帳へ書く口は無い。読む口（`GET /commitments`・`GET /commitments/:id`）は段3まで残る。
describe('人間の側の台帳の書き口は無い', () => {
  const removed: ReadonlyArray<readonly [string, string, unknown]> = [
    ['POST', '/commitments', { body: '宿題' }],
    ['POST', '/commitments/close-many', { origin: ['self'], reason: '整理', dryRun: true }],
    ['POST', '/commitments/c-1/close', { reason: '済んだ' }],
    ['POST', '/commitments/c-1/reopen', { reason: 'まだ' }],
    ['PATCH', '/commitments/c-1', { body: '直す' }],
  ];

  it.each(removed)('%s %s は 404 で、台帳の行を作らず・変えない', async (method, path, body) => {
    const { stores, send } = setup();
    await stores.commitments.open({
      id: 'c-1',
      at: '2026-10-06T00:00:00.000Z',
      origin: 'human',
      body: '元の本文',
    });
    const response = await send(method, path, body);
    expect(response.status).toBe(404);
    const { entries } = await stores.commitments.list({ includeClosed: true });
    expect(entries).toEqual([
      {
        id: 'c-1',
        at: '2026-10-06T00:00:00.000Z',
        origin: 'human',
        body: '元の本文',
      },
    ]);
  });

  it('読む口は残っている', async () => {
    const { app } = setup();
    const headers = { authorization: 'Bearer test-token' };
    expect((await app.request('/commitments', { headers })).status).toBe(200);
    expect((await app.request('/commitments/c-none', { headers })).status).toBe(404);
  });

  it('openapi に書く経路が無く、読む経路は残る', async () => {
    const { app } = setup();
    const response = await app.request('/openapi.json', {
      headers: { authorization: 'Bearer test-token' },
    });
    const doc = (await response.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(doc.paths['/commitments'] ?? {})).toEqual(['get']);
    expect(Object.keys(doc.paths['/commitments/{id}'] ?? {})).toEqual(['get']);
    expect(doc.paths['/commitments/close-many']).toBeUndefined();
    expect(doc.paths['/commitments/{id}/close']).toBeUndefined();
    expect(doc.paths['/commitments/{id}/reopen']).toBeUndefined();
  });
});
