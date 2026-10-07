import type { CloneHost, ManagerPool } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let stores: ReturnType<typeof createMemoryStores>;
let sends: { id: string; text: string }[];
let aborts: { id: string; reason: unknown }[];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  stores = createMemoryStores();
  sends = [];
  aborts = [];
  const managers = {
    async send(id: string, text: string) {
      sends.push({ id, text });
      return { outcome: 'delivered' as const, detail: '' };
    },
    async abort(id: string, ...rest: unknown[]) {
      aborts.push({ id, reason: rest[0] });
      return { outcome: 'stopped' as const, detail: '' };
    },
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

describe('NUL だけの文字列は空として断る（HTTP）', () => {
  it('POST /managers/:id/messages: text が NUL だけなら 400 で、マネージャーへ送らない', async () => {
    const empty = await app.request('/managers/mgr-1/messages', post({ text: '' }));
    const nul = await app.request('/managers/mgr-1/messages', post({ text: '\0' }));
    expect(empty.status).toBe(400);
    expect(nul.status, `空文字は 400 なのに NUL だけは ${nul.status}`).toBe(400);
    expect(sends).toEqual([]);
  });

  it('DELETE /managers/:id: reason が NUL だけなら 400 で、止めない', async () => {
    const del = (reason: string) => ({
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    const empty = await app.request('/managers/mgr-1', del(''));
    const nul = await app.request('/managers/mgr-1', del('\0'));
    expect(empty.status).toBe(400);
    expect(nul.status, `空文字は 400 なのに NUL だけは ${nul.status}`).toBe(400);
    expect(aborts).toEqual([]);
  });
});
