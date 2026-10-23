import { UnreadableCommitmentError } from '@alteroid/core';
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

describe('CommitmentStore.reopen() と読めない行（pg。#5176）', () => {
  it('読めない行は閉じていても UnreadableCommitmentError を投げ、閉じたまま書き直さない', async () => {
    await db.execute(
      sql`insert into commitments (id, at, closed_at, commitment)
          values ('broken', now(), now(), '{"id":"broken"}'::jsonb)`,
    );

    await expect(stores.commitments.reopen('broken')).rejects.toBeInstanceOf(
      UnreadableCommitmentError,
    );

    const rows = await db.execute(
      sql`select closed_at is not null as closed, commitment::text as commitment
          from commitments where id = 'broken'`,
    );
    const row = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows)[0] as {
      closed: boolean;
      commitment: string;
    };
    expect(row.closed).toBe(true);
    expect(JSON.parse(row.commitment)).toEqual({ id: 'broken' });
  });
});
