import { describe, expect, it } from 'vitest';

import { verifyJournalStorePageContract } from './journal-page-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の listPage 契約（インメモリ実装）', () => {
  it('entries は list() と同じ／next は本当に先が在るときだけ／next で全件を過不足なく読める', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStorePageContract(stores.journal)).resolves.toBeUndefined();
  });
});
