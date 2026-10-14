import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

const KEY = { projectKey: 'proj-order', sessionId: 'sess-order' };

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

// SDK の契約: 「Within a single process, persist entries in append-call order」（#4729）
describe('PgSessionStore.append() — 1回の呼び出しの中の順序を保つ（#4729）', () => {
  it('⭐ uuid の有る行と無い行が混ざっても、渡した順のまま読み戻せる', async () => {
    await stores.sessionStore.append(KEY, [
      { type: 'user', uuid: 'evt-a', text: 'A' },
      { type: 'custom-title', text: 'T（uuid 無し）' },
      { type: 'assistant', uuid: 'evt-b', text: 'B' },
      { type: 'tag', text: 'U（uuid 無し）' },
    ]);

    const loaded = await stores.sessionStore.load(KEY);
    expect(loaded?.map((entry) => (entry as unknown as { text: string }).text)).toEqual([
      'A',
      'T（uuid 無し）',
      'B',
      'U（uuid 無し）',
    ]);
  });

  it('同じ uuid の行を二度渡しても、今までどおり1行だけ残る', async () => {
    await stores.sessionStore.append(KEY, [{ type: 'user', uuid: 'evt-a', text: 'A' }]);
    await stores.sessionStore.append(KEY, [
      { type: 'user', uuid: 'evt-a', text: 'A' },
      { type: 'tag', text: 'T' },
    ]);
    const loaded = await stores.sessionStore.load(KEY);
    expect(loaded?.map((entry) => (entry as unknown as { text: string }).text)).toEqual(['A', 'T']);
  });
});
