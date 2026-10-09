import { describe, expect, it } from 'vitest';

import { verifyJournalStoreWithContract } from './journal-with-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の with 契約（インメモリ実装）', () => {
  it('未指定=絞らない／指定=その with だけ／[]=0件／limit より前に効く', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreWithContract(stores.journal)).resolves.toBeUndefined();
  });
});
