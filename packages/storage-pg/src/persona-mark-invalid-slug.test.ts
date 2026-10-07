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

describe('PersonaStore.markHumanTouched() / markCreatedAt() — 形式不正な slug の扱い（pg 実装）', () => {
  const invalidSlug = 'Invalid Slug!';
  const at = new Date().toISOString();

  it('markHumanTouched() は形式不正な slug を拒む（throw する）', async () => {
    await expect(stores.persona.markHumanTouched(invalidSlug, at)).rejects.toThrow();
  });

  it('markCreatedAt() は形式不正な slug を拒む（throw する）', async () => {
    await expect(stores.persona.markCreatedAt(invalidSlug, at)).rejects.toThrow();
  });
});
