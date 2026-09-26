import type { InboxEvent } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/inbox-reput-order.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——pg は `ORDER BY` の
 * 無い `SELECT` / `UPDATE ... RETURNING` の行の並びをそのまま JS 側の
 * 安定ソートへ渡すので、`onConflictDoUpdate` で行の物理位置が動いた
 * 再配達行は末尾寄りになる。この歯は緑になる。
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
    await stores.inbox.put(evA, at); // 再配達（同じ id・同じ at）

    const order = (await stores.inbox.peekPending()).map((entry) => entry.event.id);
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
