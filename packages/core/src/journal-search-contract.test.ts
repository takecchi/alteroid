import { describe, expect, it } from 'vitest';

import { verifyJournalStoreSearchContract } from './journal-search-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalStore` の `q`（本文を語で探す）の契約（issue #250）を、**インメモリ
 * 実装**（`testing.ts`）に対して測る。
 *
 * 同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない
 * （`journal-with-contract.test.ts` / #370 と同じ作法）:
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.test.ts`
 *
 * **契約4（`%` / `_` はワイルドカードではない）だけは、この実装では自明に
 * 通る** —— 素の `includes` にワイルドカードは無い。落ちうるのは `ILIKE` を
 * 使う pg だけである。**それでも3実装ぜんぶで測るのは、「pg でだけ測る」形に
 * すると、照合を SQL から引き上げたときに誰も測らなくなるからである。**
 */
describe('JournalStore の q 契約（インメモリ実装）', () => {
  it('未指定=絞らない／部分一致／大文字小文字を区別しない／%_ はワイルドカードでない／""=絞らない／limit より前に効く', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreSearchContract(stores.journal)).resolves.toBeUndefined();
  });
});
