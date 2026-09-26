import type { InboxEvent } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1668。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/inbox-put-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——`put()` が
 * `stripNulls(inboxEventSchema.parse(event))` を通すので、この歯は緑になる。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

describe('InboxStore.put() — 形式不正な event の扱い（pg 実装）', () => {
  const badEvent = {
    type: 'human_message',
    id: 'evt-bad',
    at: 'not-a-date', // inboxEventSchema は at を ISO 8601 として要求する
    conversationId: 'c',
    text: 'x',
  } as unknown as InboxEvent;

  it('put() は at が ISO 8601 でない event を拒む（throw する）', async () => {
    await expect(stores.inbox.put(badEvent, 'not-a-date')).rejects.toThrow();
  });
});
