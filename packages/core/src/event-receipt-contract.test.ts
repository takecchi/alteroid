import { describe, expect, it } from 'vitest';

import { verifyEventReceiptStoreContract } from './event-receipt-contract.js';
import { createMemoryStores } from './testing.js';

describe('EventReceiptStore（メモリ実装）', () => {
  it('3実装共通の契約を満たす', async () => {
    await expect(
      verifyEventReceiptStoreContract(createMemoryStores().eventReceipts),
    ).resolves.toBeUndefined();
  });
});
