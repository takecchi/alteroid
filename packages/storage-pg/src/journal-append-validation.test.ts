import type { JournalEntryInput } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1668。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/journal-append-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——`append()` が
 * `journalEntrySchema.parse(...)` を通すので、この歯は緑になる。
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

describe('JournalStore.append() — 形式不正な entry の扱い（pg 実装）', () => {
  const badInput = {
    type: 'exchange',
    with: 'nobody', // journalEntrySchema は with を 'human' | 'manager' | 'self' に限る
    role: 'inbound',
    text: '本文はなんでもよい',
  } as unknown as JournalEntryInput;

  it('append() は with が許可された値でない entry を拒む（throw する）', async () => {
    await expect(stores.journal.append(badInput)).rejects.toThrow();
  });
});
