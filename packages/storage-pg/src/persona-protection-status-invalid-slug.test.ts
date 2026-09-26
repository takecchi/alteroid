import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * issue #1700。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/persona-protection-status-invalid-slug.test.ts` の
 * 冒頭コメントを見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——`protectionStatus`
 * が `#slug()`（`memorySlugSchema.safeParse`）を通してから読むので、
 * この歯は緑になる。
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

describe('PersonaStore.protectionStatus() — 形式不正な slug の扱い（pg 実装）', () => {
  const invalidSlug = 'Invalid Slug!';

  it('protectionStatus() は形式不正な slug を拒む（throw する）', async () => {
    await expect(stores.persona.protectionStatus(invalidSlug)).rejects.toThrow();
  });
});
