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

// 畳みの控えは `daemon_state` の1行（key `clone_fold_state`）に置く。表の変更（migrate）は要らない
describe('PgSessionRegistry — 畳みの控え', () => {
  it('未記録なら null、置くと読み戻せ、null で消える', async () => {
    expect(await stores.sessions.getFoldState()).toBeNull();

    await stores.sessions.setFoldState('{"v":1}');
    expect(await stores.sessions.getFoldState()).toBe('{"v":1}');

    await stores.sessions.setFoldState('{"v":1,"x":2}');
    expect(await stores.sessions.getFoldState()).toBe('{"v":1,"x":2}');

    await stores.sessions.setFoldState(null);
    expect(await stores.sessions.getFoldState()).toBeNull();
  });

  it('⭐ セッション id を捨てる（setCloneSessionId(null)）と控えも消え、id を置き直すだけでは消えない', async () => {
    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setFoldState('{"v":1}');

    await stores.sessions.setCloneSessionId('sess-2');
    expect(await stores.sessions.getFoldState()).toBe('{"v":1}');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getFoldState()).toBeNull();
  });

  it('clear() は控えも消して数える', async () => {
    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setFoldState('{"v":1}');

    expect(await stores.sessions.clear()).toBe(2);
    expect(await stores.sessions.getFoldState()).toBeNull();
  });

  it('NUL を含む値は断る', async () => {
    await expect(stores.sessions.setFoldState('a\u0000b')).rejects.toThrow();
    expect(await stores.sessions.getFoldState()).toBeNull();
  });
});
