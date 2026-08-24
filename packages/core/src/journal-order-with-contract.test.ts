import { describe, expect, it } from 'vitest';

import { verifyJournalStoreOrderContract } from './journal-order-with-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalStore` の `order` / `after` の契約（issue #432 の2本目）を、
 * **インメモリ実装**（`testing.ts`）に対して測る。
 *
 * 同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない
 * （`journal-with-contract.test.ts` / #418 と同じ作法）:
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.test.ts`
 *
 * どの実装がこの契約を測る責任を持つかは
 * `scripts/journal-store-with-contract-registry.test.ts` が一覧として持ち、
 * 新しい `JournalStore` 実装がここへ登録されずに増えたら落ちる。
 */
describe('JournalStore の order/after 契約（インメモリ実装）', () => {
  it('order 未指定=desc／asc は正確な逆順／after は絞り・limit より前に効く／同着を飛ばさない', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreOrderContract(stores.journal)).resolves.toBeUndefined();
  });
});
