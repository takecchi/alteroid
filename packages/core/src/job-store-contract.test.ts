import { describe, expect, it } from 'vitest';

import { verifyJobStoreContract } from './job-store-contract.js';
import { createMemoryStores } from './testing.js';

describe('JobStore の契約（インメモリ実装）', () => {
  it('putJob の入口の検査・updateJob の読み直しと直列化・updateApproval の結果と null', async () => {
    await expect(verifyJobStoreContract(() => createMemoryStores().jobs)).resolves.toBeUndefined();
  });
});
