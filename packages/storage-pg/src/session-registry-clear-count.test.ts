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

describe('PgSessionRegistry — 墓標の蒸留失敗回数（#4752）', () => {
  it('未記録なら 0、数えると増え、別の印では 1 から数え直し、kind は独立している', async () => {
    const sessions = stores.sessions;
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(1);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(2);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);

    // 別の印のぶんは数えていない。数えても a の回数は消えない（#4898）
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'b')).toBe(1);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);

    // もう一方の kind には触れない
    expect(await sessions.graveDistillFailures('lost_session', 'b')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('lost_session', 'b')).toBe(1);
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(1);
  });

  it('古い形（1件だけの { graveId, failures }）の保存値も読め、数え足すと新しい形で書く（#4898）', async () => {
    await db.insert(daemonState).values({
      key: 'clone_transcript_grave_distill_failures',
      value: '{"graveId":"a","failures":2}',
    });
    const sessions = stores.sessions;
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);
    expect(await sessions.noteGraveDistillFailure('transcript', 'b')).toBe(1);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(3);
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(1);
  });

  it('墓標の本体の突き合わせには触れない（数えても clear…If は今までどおり下ろす）', async () => {
    await stores.sessions.setTranscriptGrave({ archiveId: 'a1' });
    await stores.sessions.noteGraveDistillFailure('transcript', 'a1');
    expect(await stores.sessions.clearTranscriptGraveIf('a1')).toBe(true);
  });
});
