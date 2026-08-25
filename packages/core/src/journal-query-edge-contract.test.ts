import { describe, expect, it } from 'vitest';

import { verifyJournalStoreQueryEdgeContract } from './journal-query-edge-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalQuery` の退化した値（`types: []` / `limit: 0`）の契約（issue #425）を、
 * **インメモリ実装**（`testing.ts`）に対して測る。
 *
 * 同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない
 * （`journal-with-contract.test.ts` / #418 / #370 と同じ作法）:
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.test.ts`
 *
 * どの実装がこの契約を測る責任を持つかは
 * `scripts/journal-store-with-contract-registry.test.ts` が一覧として持ち、
 * 新しい `JournalStore` 実装がここへ登録されずに増えたら落ちる。
 */
describe('JournalStore の query edge 契約（インメモリ実装）', () => {
  it('types: []=0件／limit: 0=0件／types 未指定=絞らない／指定=その種別だけ／limit:N(N>=1)はN件で切る／同時指定でも0件', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreQueryEdgeContract(stores.journal)).resolves.toBeUndefined();
  });
});
