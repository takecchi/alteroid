import { verifyInboxStoreContract } from '@alteroid/core/contracts';
import { afterEach, describe, it } from 'vitest';

import { createPgStoresFromDb } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

const clients: TestDbHandle[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('InboxStore の契約（pg 実装）', () => {
  it('積む・配る・消す・pending / peekPending・removeMany・put の入口の検査・外側の at の正規化・同着の並び', async () => {
    await verifyInboxStoreContract(async () => {
      const { client, db } = await createMigratedTestDb();
      clients.push(client);
      return createPgStoresFromDb(db).inbox;
    });
  }, 120_000);
});
