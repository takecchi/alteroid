import { verifyJobStoreContract } from '@alteroid/core/contracts';
import { afterEach, describe, it } from 'vitest';

import { createPgStoresFromDb } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

const clients: TestDbHandle[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('JobStore の契約（pg 実装）', () => {
  it('putJob の入口の検査・updateJob の読み直しと直列化・updateApproval の結果と null', async () => {
    await verifyJobStoreContract(async () => {
      const { client, db } = await createMigratedTestDb();
      clients.push(client);
      return createPgStoresFromDb(db).jobs;
    });
  }, 120_000);
});
