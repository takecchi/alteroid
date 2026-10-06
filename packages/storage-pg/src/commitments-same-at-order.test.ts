import { createMemoryStores, type Commitment } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

/**
 * 同じ `at` の未了行（台帳は `at` の古い順に並べる）の並びは、行を直した後も変わらない。
 * in-memory / fs は安定整列（入れた順）。pg は `order by at` だけで同順位の決め手が無く、
 * jsonb_set で行を更新（物理的に別のタプルになる）すると並びが入れ替わりうる。
 */
let client: TestDbHandle;
let stores: PgStores;

beforeEach(async () => {
  const handle = await createMigratedTestDb();
  client = handle.client;
  stores = createPgStoresFromDb(handle.db);
});

afterEach(async () => {
  await client.close();
});

const AT = '2026-01-01T00:00:00.000Z';
const row = (id: string): Commitment => ({ id, at: AT, origin: 'self', body: `body ${id}` });

describe('台帳: 同じ at の未了の並び', () => {
  it('editBody のあとも入れた順のまま（in-memory と同じ）', async () => {
    const memory = createMemoryStores().commitments;
    for (const s of [memory, stores.commitments]) {
      for (const id of ['a', 'b', 'c']) await s.open(row(id));
      await s.editBody('a', '直した', '2026-01-02T00:00:00.000Z', 'clone');
    }
    const expected = (await memory.list()).entries.map((e) => e.id);
    const actual = (await stores.commitments.list()).entries.map((e) => e.id);
    expect(actual).toEqual(expected);
  });
});
