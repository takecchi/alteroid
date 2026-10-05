import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/token-pool-replace-validation.test.ts` の冒頭コメントを
 * 見よ。
 *
 * ここは pg 実装（PGlite）に対して同じ入力を当てる——pg は zod での検査を
 * 持たないが、`order_index` 列が SQL の整数型なので非整数を渡すと DB 側の
 * 型検査で落ちる。結果としてこの歯は緑になる。
 */
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('TokenPoolStore.replace() — order が非整数の AgentToken の扱い（pg 実装）', () => {
  it('replace() は order が非整数の行を拒む（throw する）', async () => {
    const badToken = { id: 't1', label: 'x', order: 1.5 };
    await expect(stores.tokens.replace([badToken])).rejects.toThrow();
  });
});
