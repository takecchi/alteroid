import type { JournalEntryInput } from '@alteroid/core';
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

describe('JournalStore.append() — 形式不正な entry の扱い（pg 実装）', () => {
  const badInput = {
    type: 'exchange',
    with: 'nobody',
    role: 'inbound',
    text: '本文はなんでもよい',
  } as unknown as JournalEntryInput;

  it('append() は with が許可された値でない entry を拒む（throw する）', async () => {
    await expect(stores.journal.append(badInput)).rejects.toThrow();
  });
});
