import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';
import { daemonState } from './schema.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

describe('PgSessionRegistry.clear() — 4つの欄だけを数え、数えた欄だけを消す', () => {
  it('何も置いていなければ 0 を返す（fs と同じ）', async () => {
    expect(await stores.sessions.clear()).toBe(0);
  });

  it('4つの欄をすべて置くと 4 を返し、4つとも空になる', async () => {
    await stores.sessions.setCloneSessionId('s1');
    await stores.sessions.setTranscriptGrave({ archiveId: 'a1' });
    await stores.sessions.setLostSessionGrave({ projectKey: 'pk', sessionId: 's0' });
    await stores.sessions.setProjectKey('pk');

    expect(await stores.sessions.clear()).toBe(4);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
    expect(await stores.sessions.getLostSessionGrave()).toBeNull();
    expect(await stores.sessions.getProjectKey()).toBeNull();
  });

  it('migrate が置いた「旧プロファイルを写し終えた」印は消さない', async () => {
    await stores.sessions.setProjectKey('pk');
    await stores.sessions.clear();

    const marker = await db
      .select()
      .from(daemonState)
      .where(eq(daemonState.key, 'env_profile_entries_migrated'));
    expect(marker).toHaveLength(1);
  });
});
