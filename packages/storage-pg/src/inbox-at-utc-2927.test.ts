import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

/**
 * issue #2927 項目2。`inbox.put(event, at)` の外側の `at` は、pg が `timestamptz` 経由で
 * `Z` 付きの ISO 表記（`new Date(at).toISOString()`）に正規化して返す。fs も同じ表記で
 * 返す（対の歯は `packages/storage-fs/src/inbox-at-utc-2927.test.ts`）。
 */
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

const event: InboxEvent = {
  type: 'human_message',
  id: 'evt-a',
  at: '2026-08-12T09:00:00+09:00',
  conversationId: 'c',
  text: 'A',
};

describe('InboxStore.put() — 外側の at の表記（pg 実装）', () => {
  it('+09:00 を渡すと Z で返る（peekPending と pending().oldestAt）', async () => {
    await stores.inbox.put(event, '2026-08-12T09:00:00+09:00');
    const [entry] = (await stores.inbox.peekPending()).entries;
    expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
    // event の中の at は触らない
    expect(entry?.event.at).toBe('2026-08-12T09:00:00+09:00');
    expect((await stores.inbox.pending()).oldestAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('不正な時刻は put が拒む（throw する。何も保存しない）', async () => {
    await expect(stores.inbox.put(event, 'not-a-date')).rejects.toThrow();
    expect((await stores.inbox.pending()).count).toBe(0);
  });
});
