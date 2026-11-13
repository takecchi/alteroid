import { verifyJobStoreContract } from '@alteroid/core/contracts';
import { describe, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('JobStore の契約（fs 実装）', () => {
  it('putJob の入口の検査・updateJob の読み直しと直列化・updateApproval の結果と null', async () => {
    await verifyJobStoreContract(async () => {
      const root = await makeTempDir('alteroid-test-');
      return createFsStores(root).jobs;
    });
  });
});
