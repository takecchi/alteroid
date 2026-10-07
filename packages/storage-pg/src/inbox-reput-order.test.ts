import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('InboxStore — 同着の2次キー（再配達された行は末尾へ回る。pg 実装）', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const evA: InboxEvent = {
    type: 'human_message',
    id: 'evt-a',
    at,
    conversationId: 'c',
    text: 'A',
  };
  const evB: InboxEvent = {
    type: 'human_message',
    id: 'evt-b',
    at,
    conversationId: 'c',
    text: 'B',
  };

  it('put(A) → put(B) → put(A) 再配達（同じ at）の後、peekPending() は (B, A) になる', async () => {
    await stores.inbox.put(evA, at);
    await stores.inbox.put(evB, at);
    await stores.inbox.put(evA, at);

    const order = (await stores.inbox.peekPending()).entries.map((entry) => entry.event.id);
    expect(order).toEqual(['evt-b', 'evt-a']);
  });

  it('claimPending() も同じ順序になる', async () => {
    await stores.inbox.put(evA, at);
    await stores.inbox.put(evB, at);
    await stores.inbox.put(evA, at);

    const order = (await stores.inbox.claimPending()).map((entry) => entry.event.id);
    expect(order).toEqual(['evt-b', 'evt-a']);
  });
});
