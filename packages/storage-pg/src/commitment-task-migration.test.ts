import { verifyCommitmentTaskMigrationContract } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { describe, it } from 'vitest';

import { createPgStoresFromDb } from './index.js';
import { tasks } from './schema.js';
import { createMigratedTestDb } from './test-db.test-support.js';

describe('台帳→Task の移行（pg）', () => {
  it('3実装共通の契約を満たす（読めない行を含む）', async () => {
    await verifyCommitmentTaskMigrationContract(async () => {
      const { client, db } = await createMigratedTestDb();
      return {
        stores: createPgStoresFromDb(db),
        dispose: () => client.close(),
        plantUnreadableCommitment: async (id) => {
          await db.execute(
            sql`insert into commitments (id, at, commitment)
                values (
                  ${id},
                  '2026-09-02T00:00:00.000Z',
                  ${JSON.stringify({
                    id,
                    at: '2026-09-02T00:00:00.000Z',
                    origin: 'future-origin',
                    body: '壊れた本文',
                  })}::jsonb
                )`,
          );
        },
        plantUnreadableTask: async (id) => {
          await db.insert(tasks).values({
            id,
            rank: 1,
            task: { id, createdAt: '2026-01-01T00:00:00.000Z', status: 'weird' },
          });
        },
      };
    });
  }, 60_000);
});
