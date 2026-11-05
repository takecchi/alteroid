import { captureStderr, verifyTranscriptArchiveContract } from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { archive } from './schema.js';
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

describe('PgInboxStore', () => {
  // `claimPending()` が投げる期待にしない: 読めない1行が起動時の未読の復元を丸ごと止め、ほかの正しい未読まで配られなくなるため。
  it('読めない行を「消された」に潰さない（fs 版と同じく失敗を表へ出す）', async () => {
    await db.execute(
      sql`insert into inbox_events (id, event, at, deliveries)
          values ('broken', '{"id":"broken"}'::jsonb, now(), 0)`,
    );

    let claimed: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        claimed = (await stores.inbox.claimPending()).map((entry) => entry.event.id);
      })
    ).join('');

    expect(claimed).toEqual([]);
    expect(stderr).toContain('broken');
    expect((await stores.inbox.pending()).count).toBe(1);
  });
});

describe('PgTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = (await stores.archive.archive('session-1', '{"a":1}\n')).id;

    expect((await stores.archive.list()).map((entry) => entry.id)).toContain(id);
    expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: '{"a":1}\n' });
  });

  it('無い id は missing（removed とは別物）', async () => {
    expect(await stores.archive.read('居ない')).toEqual({ kind: 'missing' });
  });

  it('TranscriptArchive の契約を満たす', async () => {
    await verifyTranscriptArchiveContract(stores.archive, {
      // 生 SQL を使う: drizzle 経由だと `.default` 等で値が入りうるため。
      seedFingerprintlessRow: async (sessionId, body) => {
        const id = `${sessionId}-fingerprintless-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await db.execute(
          sql`insert into archive (id, session_id, at, body) values (${id}, ${sessionId}, now(), ${body})`,
        );
        return id;
      },
    });
  });

  it('remove() は行を消さない（本文だけを落とす。list() に出続ける）', async () => {
    const id = (await stores.archive.archive('session-remove', 'BODY\n')).id;

    const removed = await stores.archive.remove(id);
    expect(removed).toEqual({ kind: 'removed', bytes: Buffer.byteLength('BODY\n', 'utf8') });

    expect((await stores.archive.list()).map((entry) => entry.id)).toContain(id);
    expect(await stores.archive.read(id)).toMatchObject({ kind: 'removed' });

    const rows = await db.select().from(archive).where(eq(archive.id, id));
    expect(rows[0]?.body).toBe('');
    expect(rows[0]?.removedAt).not.toBeNull();
  });

  it('存在しない id への remove() は黙って成功しない（missing）', async () => {
    expect(await stores.archive.remove('居ない')).toEqual({ kind: 'missing' });
  });

  it('id A を消しても id B は読める（巻き添えが無い）', async () => {
    const idA = (await stores.archive.archive('session-a', 'A\n')).id;
    const idB = (await stores.archive.archive('session-b', 'B\n')).id;

    await stores.archive.remove(idA);

    expect(await stores.archive.read(idA)).toMatchObject({ kind: 'removed' });
    expect(await stores.archive.read(idB)).toEqual({ kind: 'body', body: 'B\n' });
  });

  it('空の生ログを退避しただけの行は removed にならない（body の空文字を判定に使わない）', async () => {
    const id = (await stores.archive.archive('session-empty', '')).id;

    const rows = await db.select().from(archive).where(eq(archive.id, id));
    expect(rows[0]?.body).toBe('');
    expect(rows[0]?.removedAt).toBeNull();

    expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: '' });
  });

  it('二重の remove() は冪等（removed → already。バイト数・removedAt は変わらない）', async () => {
    const id = (await stores.archive.archive('session-twice', 'TWICE\n')).id;

    const first = await stores.archive.remove(id);
    expect(first).toEqual({ kind: 'removed', bytes: Buffer.byteLength('TWICE\n', 'utf8') });

    const readAfterFirst = await stores.archive.read(id);
    if (readAfterFirst.kind !== 'removed') throw new Error('removed のはず');

    const second = await stores.archive.remove(id);
    expect(second).toEqual({
      kind: 'already',
      removedAt: readAfterFirst.removedAt,
      bytes: Buffer.byteLength('TWICE\n', 'utf8'),
    });
  });

  it('list()のstoredBytesはpg_column_size(body)と一致する（#698）', async () => {
    const id = (await stores.archive.archive('session-column-size', 'HELLO WORLD\n')).id;

    const entry = (await stores.archive.list()).find((e) => e.id === id);
    expect(entry).toBeDefined();

    const [row] = await db
      .select({ size: sql<number>`pg_column_size(${archive.body})` })
      .from(archive)
      .where(eq(archive.id, id));
    expect(entry?.storedBytes).toBe(row?.size);
  });

  it('sessions()は同一sessionIdの行数(tombstone済み込み)を正しく数える', async () => {
    // 1ミリ秒ずつ空ける: id がミリ秒精度で、同じミリ秒に積むと衝突するため。
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
    const idA = (await stores.archive.archive('session-grouped', 'A\n')).id;
    await tick();
    await stores.archive.archive('session-grouped', 'BB\n');
    await tick();
    await stores.archive.archive('session-grouped', 'CCC\n');
    await stores.archive.remove(idA);

    const summaries = await stores.archive.sessions();
    const summary = summaries.find((s) => s.sessionId === 'session-grouped');
    expect(summary?.rows).toBe(3);
  });

  it('sessions()のcontinuityはfirst/continues/diverged/unknown/absentを正しく数える', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
    const sessionId = 'session-continuity-tally';

    const writeFirst = await stores.archive.archive(sessionId, 'A\n');
    expect(writeFirst.continuity).toBe('first');
    await tick();
    const writeContinues = await stores.archive.archive(sessionId, 'A\nB\n');
    expect(writeContinues.continuity).toBe('continues');
    await tick();
    const writeDiverged = await stores.archive.archive(sessionId, 'X\n');
    expect(writeDiverged.continuity).toBe('diverged');
    await tick();

    const legacyId = `${sessionId}-legacy`;
    await db.execute(
      sql`insert into archive (id, session_id, at, body) values (${legacyId}, ${sessionId}, now(), ${'LEGACY\n'})`,
    );
    await tick();

    const writeAfterLegacy = await stores.archive.archive(sessionId, 'ANYTHING\n');
    expect(writeAfterLegacy.continuity).toBe('unknown');

    const summaries = await stores.archive.sessions();
    const summary = summaries.find((s) => s.sessionId === sessionId);
    expect(summary?.rows).toBe(5);
    expect(summary?.continuity).toEqual({
      first: 1,
      continues: 1,
      diverged: 1,
      unknown: 1,
      absent: 1,
    });
  });

  // 時計を `toFake: ['Date']` に絞る: `setTimeout` まで偽物にすると PGlite の待ちが止まるため。
  it('同じミリ秒に2回積むと archive に2行残り、body が2本とも別々（#905）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let first: string;
    let second: string;
    try {
      vi.setSystemTime(new Date('2026-09-12T03:04:05.678Z'));
      first = (await stores.archive.archive('session-collision', 'FIRST\n')).id;
      second = (await stores.archive.archive('session-collision', 'SECOND\n')).id;
    } finally {
      vi.useRealTimers();
    }

    expect(first).toBe('session-collision-2026-09-12T03-04-05-678Z.jsonl');
    expect(second).toBe('session-collision-2026-09-12T03-04-05-678Z-2.jsonl');

    const rows = await db.select().from(archive).where(eq(archive.sessionId, 'session-collision'));
    expect(rows).toHaveLength(2);
    const bodyById = new Map(rows.map((row) => [row.id, row.body]));
    expect(bodyById.get(first)).toBe('FIRST\n');
    expect(bodyById.get(second)).toBe('SECOND\n');
  });

  // 枝番を id の先頭側へ付けない: 前方一致 LIKE が主キーの btree に落ちなくなるため。
  it("where id like 'session-…%' の前方一致が枝番付きの2本目も拾う（#905）", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let first: string;
    let second: string;
    try {
      vi.setSystemTime(new Date('2026-09-12T03:04:05.678Z'));
      first = (await stores.archive.archive('session-collision', 'FIRST\n')).id;
      second = (await stores.archive.archive('session-collision', 'SECOND\n')).id;
    } finally {
      vi.useRealTimers();
    }

    const prefixed = await db
      .select({ id: archive.id })
      .from(archive)
      .where(sql`${archive.id} like ${'session-collision-%'}`);
    expect(new Set(prefixed.map((row) => row.id))).toEqual(new Set([first, second]));
  });
});
