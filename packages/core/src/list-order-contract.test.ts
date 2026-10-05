import { describe, it } from 'vitest';

import { verifyListOrderContract } from './list-order-contract.js';
import { createMemoryStores } from './testing.js';

describe('一覧の並びの契約（#2913）— インメモリ', () => {
  it('名前の並びがコード単位の順である', async () => {
    await verifyListOrderContract(createMemoryStores());
  });
});
