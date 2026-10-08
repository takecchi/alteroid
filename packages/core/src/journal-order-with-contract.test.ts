import { describe, expect, it } from 'vitest';

import { verifyJournalStoreOrderContract } from './journal-order-with-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の order/after 契約（インメモリ実装）', () => {
  it('order 未指定=desc／asc は正確な逆順／after は絞り・limit より前に効く／同着を飛ばさない', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreOrderContract(stores.journal)).resolves.toBeUndefined();
  });
});
