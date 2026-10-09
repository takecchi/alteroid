import { describe, expect, it } from 'vitest';

import { verifyJournalStoreSearchContract } from './journal-search-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の q 契約（インメモリ実装）', () => {
  it('未指定=絞らない／部分一致／大文字小文字を区別しない／%_ はワイルドカードでない／""=絞らない／limit より前に効く', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreSearchContract(stores.journal)).resolves.toBeUndefined();
  });
});
