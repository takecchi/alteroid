import { createMemoryStores } from '@alteroid/core';
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

describe('persona: 末尾が NUL の本文の正規化は実装で同じ', () => {
  for (const input of ['x\n\u0000', 'x\u0000', '\u0000', 'x\n\u0000\n\u0000']) {
    it(`write(${JSON.stringify(input)})`, async () => {
      const memory = createMemoryStores().persona;
      const expected = await memory.write('doc', input);
      const pg = await stores.persona.write('doc', input);
      expect(pg.content).toBe(expected.content);
      expect((await stores.persona.read('doc'))?.content).toBe(expected.content);
    });
    it(`append(${JSON.stringify(input)})`, async () => {
      const memory = createMemoryStores().persona;
      await memory.write('doc', '# T\n');
      await stores.persona.write('doc', '# T\n');
      const expected = await memory.append('doc', input);
      const pg = await stores.persona.append('doc', input);
      expect(pg.content).toBe(expected.content);
    });
  }
});
