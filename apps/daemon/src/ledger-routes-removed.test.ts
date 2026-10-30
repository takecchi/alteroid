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
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { stores, app, send };
}

// 台帳の撤去の段3: 台帳を読む口・台帳から task へ移す口も無い（書く口は段2bで外れた）。
describe('台帳の口は無い', () => {
  const removed: ReadonlyArray<readonly [string, string, unknown]> = [
    ['GET', '/commitments', undefined],
    ['GET', '/commitments/c-1', undefined],
    ['POST', '/commitments', { body: '宿題' }],
    ['POST', '/commitments/close-many', { origin: ['self'], reason: '整理', dryRun: true }],
    ['POST', '/commitments/c-1/close', { reason: '済んだ' }],
    ['POST', '/commitments/c-1/reopen', { reason: 'まだ' }],
    ['PATCH', '/commitments/c-1', { body: '直す' }],
    ['GET', '/tasks/migration-plan', undefined],
    ['POST', '/tasks/migrate', { fingerprint: 'x' }],
  ];

  it.each(removed)('%s %s は 404', async (method, path, body) => {
    const { send } = setup();
    const response = await send(method, path, body);
    expect(response.status).toBe(404);
  });

  it('openapi に台帳・移行の経路も commitments の tag も無い', async () => {
    const { app } = setup();
    const response = await app.request('/openapi.json', {
      headers: { authorization: 'Bearer test-token' },
    });
    const doc = (await response.json()) as {
      paths: Record<string, unknown>;
      tags?: { name: string }[];
    };
    const paths = Object.keys(doc.paths);
    expect(paths.filter((path) => path.startsWith('/commitments'))).toEqual([]);
    expect(paths).not.toContain('/tasks/migration-plan');
    expect(paths).not.toContain('/tasks/migrate');
    expect((doc.tags ?? []).map((tag) => tag.name)).not.toContain('commitments');
  });
});
