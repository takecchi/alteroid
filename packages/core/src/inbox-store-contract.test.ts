import { describe, expect, it } from 'vitest';

import { verifyInboxStoreContract } from './inbox-store-contract.js';
import { createMemoryStores } from './testing.js';

describe('InboxStore の契約（インメモリ実装）', () => {
  it('積む・配る・消す・pending / peekPending・removeMany・put の入口の検査・外側の at の正規化・同着の並び', async () => {
    await expect(
      verifyInboxStoreContract(() => createMemoryStores().inbox),
    ).resolves.toBeUndefined();
  });
});
