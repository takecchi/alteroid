import type { CloneHost, InboxEvent, ManagerPool } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let stores: ReturnType<typeof createMemoryStores>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  stores = createMemoryStores();
  const managers = {
    runningManagerOwning: () => undefined,
    async list() {
      return [];
    },
    denials: () => [],
  } as unknown as ManagerPool;
  const clone = {
    post: () => undefined,
    dropQueuedInboxEvents: async (ids: readonly string[]) => ids.length,
    subscribe: () => () => undefined,
    managers,
  } as unknown as CloneHost;
  app = createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
});

describe('配列の要素が NUL だけの呼びは、空文字の要素と同じく 400 で断る（HTTP）', () => {
  it('POST /inbox/remove: sources: ["\\0"] は 400、未読は変わらない', async () => {
    const event = {
      type: 'external',
      id: 'e-1',
      at: '2026-01-01T00:00:00.000Z',
      source: 'webhook',
    } as InboxEvent;
    await stores.inbox.put(event, event.at);
    const body = { types: ['external'], reason: 'r', dryRun: false };
    const empty = await app.request('/inbox/remove', post({ ...body, sources: [''] }));
    const nul = await app.request('/inbox/remove', post({ ...body, sources: ['\0'] }));
    expect(empty.status).toBe(400);
    expect(nul.status, `空文字は 400 なのに NUL だけは ${nul.status}: ${await nul.text()}`).toBe(
      400,
    );
    expect((await stores.inbox.peekPending()).entries.map((r) => r.event.id)).toEqual(['e-1']);
  });

  it('POST /archive/remove: sessionIds: ["\\0"] は 400、本文は消えない', async () => {
    const oldRow = await stores.archive.archive('sess-a', 'AAA');
    await stores.archive.archive('sess-a', 'AAABBB');
    const body = { reason: 'r', dryRun: false };
    const empty = await app.request('/archive/remove', post({ ...body, sessionIds: [''] }));
    const nul = await app.request('/archive/remove', post({ ...body, sessionIds: ['\0'] }));
    expect(empty.status).toBe(400);
    expect(nul.status, `空文字は 400 なのに NUL だけは ${nul.status}: ${await nul.text()}`).toBe(
      400,
    );
    expect(await stores.archive.read(oldRow.id)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('NUL が混じっても中身が残る要素は今までどおり通る（inbox sources / archive sessionIds）', async () => {
    const inbox = await app.request(
      '/inbox/remove',
      post({ types: ['external'], sources: ['web\0hook'], reason: 'r', dryRun: true }),
    );
    expect(inbox.status).toBe(200);
    const archive = await app.request(
      '/archive/remove',
      post({ sessionIds: ['sess\0-a'], reason: 'r', dryRun: true }),
    );
    expect(archive.status).toBe(200);
  });
});
