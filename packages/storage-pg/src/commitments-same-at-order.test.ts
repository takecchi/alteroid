import { createMemoryStores, type Commitment } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

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
