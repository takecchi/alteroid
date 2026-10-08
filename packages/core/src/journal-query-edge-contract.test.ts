import { describe, expect, it } from 'vitest';

import { verifyJournalStoreQueryEdgeContract } from './journal-query-edge-contract.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の query edge 契約（インメモリ実装）', () => {
  it('types: []=0件／limit: 0=0件／types 未指定=絞らない／指定=その種別だけ／limit:N(N>=1)はN件で切る／同時指定でも0件', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreQueryEdgeContract(stores.journal)).resolves.toBeUndefined();
  });
});
