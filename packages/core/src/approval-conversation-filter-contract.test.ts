import { describe, it } from 'vitest';

import { verifyApprovalConversationFilterContract } from './approval-conversation-filter-contract.js';
import { createMemoryStores } from './testing.js';

describe('承認の会話の絞りの契約（#3290）— インメモリ', () => {
  it('会話の絞りが、絞らない結果を一致で絞ったものと同じ', async () => {
    await verifyApprovalConversationFilterContract(createMemoryStores());
  });
});
