import { describe, expect, it } from 'vitest';

import { verifyJournalStoreWithContract } from './journal-with-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalStore` の `with` 絞りの契約（issue #418）を、**インメモリ実装**
 * （`testing.ts`）に対して測る。
 *
 * 同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない
 * （`persona-contract.test.ts` / #370 と同じ作法）:
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.test.ts`
 *
 * どの実装がこの契約を測る責任を持つかは
 * `scripts/journal-store-with-contract-registry.test.ts` が一覧として持ち、
 * 新しい `JournalStore` 実装がここへ登録されずに増えたら落ちる。
 */
describe('JournalStore の with 契約（インメモリ実装）', () => {
  it('未指定=絞らない／指定=その with だけ／[]=0件／limit より前に効く', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreWithContract(stores.journal)).resolves.toBeUndefined();
  });
});
