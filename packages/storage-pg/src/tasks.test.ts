import { UnreadableTaskError, verifyTaskStoreContract } from '@alteroid/core';
import type { Task } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { tasks } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

const NOW = '2026-01-01T00:00:00.000Z';
const make = (id: string, origin: Task['origin'] = 'self'): Task => ({
  id,
  createdAt: NOW,
  updatedAt: NOW,
  status: 'queued',
  origin,
  title: id,
  body: id,
});

describe('TaskStore（pg）', () => {
  it('3実装共通の契約を満たす（読めない行を含む）', async () => {
    await verifyTaskStoreContract(stores.tasks, {
      plantUnreadable: async (id) => {
        await db.insert(tasks).values({
          id,
          rank: 1,
          task: { id, createdAt: NOW, status: 'weird' },
        });
      },
    });
  });

  it('rank は専用の列に入り、jsonb の行には並びの欄が混ざらない', async () => {
    await stores.tasks.add(make('a'));
    const rows = await db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]?.rank).toBe('number');
    expect(Object.keys(rows[0]?.task as object)).not.toContain('rank');
  });

  it('読めない行は書き込みの後も生の値のまま残る', async () => {
    await stores.tasks.add(make('ok'));
    await db
      .insert(tasks)
      .values({ id: 'broken', rank: 5, task: { id: 'broken', status: 'weird' } });
    await stores.tasks.setStatus('ok', 'waiting', { by: 'clone', at: NOW });
    const raw = await db.execute(sql`select task from tasks where id = 'broken'`);
    const rows = Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? []);
    expect(rows).toHaveLength(1);
    await expect(stores.tasks.get('broken')).rejects.toBeInstanceOf(UnreadableTaskError);
  });

  it('同時の add が同じ rank を割り当てず、並びが一意に決まる（advisory lock）', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => stores.tasks.add(make(`p${index}`))));
    const ranks = (await db.select({ rank: tasks.rank }).from(tasks)).map((row) => row.rank);
    expect(new Set(ranks).size).toBe(8);
    expect((await stores.tasks.list()).entries).toHaveLength(8);
  });
});
