import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';
import { daemonState } from './schema.js';

/**
 * `SessionRegistry.clear()` の契約は「ここが持つ4つの欄を消し、**消した欄の数
 * （0〜4）**を返す」（`packages/core/src/store.ts`）。fs 実装は4つのファイルだけを
 * 数える。pg 実装は `daemon_state` テーブル全体を消して行数を返していたが、この表には
 * migrate が置く「実行環境プロファイルの旧形式を移し終えた」印
 * （`env_profile_entries_migrated`、`migrate.ts`）も入っている。
 *
 * - 何も置いていない新しい DB でも `clear()` が 1 を返す（fs は 0）。
 * - 4つの欄をすべて置くと 5 を返す（契約の上限は 4）。
 * - 「1度だけ」の印まで消えるので、次の起動の migrate が旧表を写し直しうる。
 */
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedPglite());
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
