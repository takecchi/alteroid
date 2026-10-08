import { describe, expect, it } from 'vitest';

import { verifyJournalStoreHorizonContract } from './journal-horizon-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の日誌の地平の契約（インメモリ実装）', () => {
  it('空なら null／1件ならその at／複数件でも最古のまま', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreHorizonContract(stores.journal)).resolves.toBeUndefined();
  });
});
