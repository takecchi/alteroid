import { describe, expect, it } from 'vitest';

import { verifyEventIdempotencyStoreContract } from './event-idempotency-contract.js';
import { createMemoryStores } from './testing.js';

describe('EventIdempotencyStore の契約（インメモリ実装）', () => {
  it('同じ組は1件目の id を返す・並行でも1本・期限・手放し・NUL', async () => {
    await expect(
      verifyEventIdempotencyStoreContract(createMemoryStores().eventIdempotency),
    ).resolves.toBeUndefined();
  });
});
