import { verifyInboxStoreContract } from '@alteroid/core';
import { describe, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('InboxStore の契約（fs 実装）', () => {
  it('積む・配る・消す・pending / peekPending・removeMany・put の入口の検査・外側の at の正規化・同着の並び', async () => {
    await verifyInboxStoreContract(async () => {
      const root = await makeTempDir('alteroid-test-');
      return createFsStores(root).inbox;
    });
  });
});
