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

describe('InboxStore.put() — 形式不正な event の扱い（pg 実装）', () => {
  const badEvent = {
    type: 'human_message',
    id: 'evt-bad',
    at: 'not-a-date',
    conversationId: 'c',
    text: 'x',
  } as unknown as InboxEvent;

  it('put() は at が ISO 8601 でない event を拒む（throw する）', async () => {
    await expect(stores.inbox.put(badEvent, 'not-a-date')).rejects.toThrow();
  });
});
