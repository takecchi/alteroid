import { describe, expect, it } from 'vitest';

import { verifyJournalStoreHorizonContract } from './journal-horizon-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalStore.oldestAt()`（日誌の地平。issue #1510）の契約を、**インメモリ
 * 実装**（`testing.ts`）に対して測る。
 *
 * 同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない
 * （`journal-query-edge-contract.test.ts` / #418 / #370 と同じ作法）:
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.test.ts`
 *
 * どの実装がこの契約を測る責任を持つかは
 * `scripts/journal-store-with-contract-registry.test.ts` が一覧として持ち、
 * 新しい `JournalStore` 実装がここへ登録されずに増えたら落ちる。
 */
describe('JournalStore の日誌の地平の契約（インメモリ実装）', () => {
  it('空なら null／1件ならその at／複数件でも最古のまま', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreHorizonContract(stores.journal)).resolves.toBeUndefined();
  });
});
