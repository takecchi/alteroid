import { verifyApprovalConversationFilterContract } from '@alteroid/core';
import { describe, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('承認の会話の絞りの契約（#3290）— fs', () => {
  it('会話の絞りが、絞らない結果を一致で絞ったものと同じ', async () => {
    const root = await makeTempDir('alteroid-test-');
    await verifyApprovalConversationFilterContract(createFsStores(root));
  });
});
