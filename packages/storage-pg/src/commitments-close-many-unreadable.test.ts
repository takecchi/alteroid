import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('CommitmentStore.closeMany() と読めない行（pg）', () => {
  it('close() が閉じられる読めない行は closeMany() でも閉じられ、その id が返る', async () => {
    await db.execute(
      sql`insert into commitments (id, at, commitment)
          values ('broken', now(), '{"id":"broken"}'::jsonb)`,
    );
    const closed = await stores.commitments.closeMany(
      ['broken'],
      '2026-09-03T00:00:00.000Z',
      '閉じた',
      'human',
    );
    expect(closed).toEqual(['broken']);
  });
});
