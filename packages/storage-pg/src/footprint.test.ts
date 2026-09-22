import { randomBytes } from 'node:crypto';

import type { Commitment } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { measureStorageFootprint } from './footprint.js';
import { migrate } from './migrate.js';
import { archive, commitments, inboxEvents, jobs, journal } from './schema.js';

/**
 * `pg_column_size` は**保存された**（PGLZ で圧縮されうる）サイズを見る。
 * `'x'.repeat(n)` のような単純な繰り返し文字列は圧縮率が高すぎて、長さを
 * 変えても圧縮後サイズがほぼ変わらない——「大きい本文ほど値が増える」ことを
 * 確かめたいテストにとっては罠になる。高エントロピーな本文（乱数の16進文字列）
 * を使い、圧縮では潰れないサイズの違いを作る。
 */
function randomBody(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString('hex')
    .slice(0, chars);
}

/**
 * `measureStorageFootprint`（#1283、段2）の受け入れ確認。
 *
 * PGlite（インプロセスの実 PostgreSQL）を使う——`pg_column_size` / `FILTER
 * (WHERE …)` は素の Postgres の機能なので、偽物の DB では確かめたことに
 * ならない（`index.test.ts` 冒頭の doc と同じ理由）。
 */
let client: PGlite;
let db: Db;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
});

afterEach(async () => {
  await client.close();
});

describe('measureStorageFootprint（空の DB）', () => {
  it('5つの表すべてで「実測して0」——nullではない', async () => {
    const footprint = await measureStorageFootprint(db);

    expect(footprint.jobs).toEqual({ rows: 0, bytes: 0, maxBytes: 0 });
    expect(footprint.commitments).toEqual({
      open: { rows: 0, bytes: 0, maxBytes: 0 },
      closed: { rows: 0, bytes: 0, maxBytes: 0 },
    });
    expect(footprint.inboxEvents).toEqual({ rows: 0, bytes: 0, maxBytes: 0, maxDeliveries: 0 });
    expect(footprint.journal).toEqual({
      all: { rows: 0, bytes: 0 },
      recent3d: { rows: 0, bytes: 0 },
    });
    expect(footprint.archive).toEqual({ rows: 0, bytes: 0, maxBytes: 0 });
  });
});

describe('measureStorageFootprint（積んだぶんだけ増える）', () => {
  it('jobs: 行数と合計バイトが増える', async () => {
    const before = await measureStorageFootprint(db);
    expect(before.jobs).toEqual({ rows: 0, bytes: 0, maxBytes: 0 });

    await db.insert(jobs).values({
      id: 'job-1',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { body: randomBody(1_000) },
    });
    const afterOne = await measureStorageFootprint(db);
    expect(afterOne.jobs.rows).toBe(1);
    expect(afterOne.jobs.bytes).not.toBeNull();
    // jsonb はエンコードが変わるので厳密な一致は求めない——「本当に測っている」
    // ことだけを見る（`session-store.ts` の `measureSize` のテストと同じ判断）。
    expect(afterOne.jobs.bytes as number).toBeGreaterThan(900);
    expect(afterOne.jobs.maxBytes).toBe(afterOne.jobs.bytes);

    await db.insert(jobs).values({
      id: 'job-2',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { body: randomBody(5_000) },
    });
    const afterTwo = await measureStorageFootprint(db);
    expect(afterTwo.jobs.rows).toBe(2);
    expect(afterTwo.jobs.bytes as number).toBeGreaterThan(afterOne.jobs.bytes as number);
    // 最大1行は job-2 のほうが大きい
    expect(afterTwo.jobs.maxBytes as number).toBeGreaterThan(afterOne.jobs.maxBytes as number);
  });

  it('commitments: 未了と片付きは独立して数える', async () => {
    const openEntry: Commitment = {
      id: 'c-open',
      at: '2026-09-20T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-1',
      body: randomBody(1_000),
    };
    const closedEntry: Commitment = {
      id: 'c-closed',
      at: '2026-09-19T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-1',
      body: randomBody(2_000),
    };
    await db.insert(commitments).values([
      { id: openEntry.id, at: new Date(openEntry.at), closedAt: null, commitment: openEntry },
      {
        id: closedEntry.id,
        at: new Date(closedEntry.at),
        closedAt: new Date('2026-09-19T01:00:00.000Z'),
        commitment: closedEntry,
      },
    ]);

    const footprint = await measureStorageFootprint(db);
    expect(footprint.commitments.open.rows).toBe(1);
    expect(footprint.commitments.closed.rows).toBe(1);
    expect(footprint.commitments.open.bytes as number).toBeGreaterThan(900);
    expect(footprint.commitments.closed.bytes as number).toBeGreaterThan(1_900);
    // 未了の合計バイトは片付きの本文を含まない（独立して数える）
    expect(footprint.commitments.open.bytes as number).toBeLessThan(
      footprint.commitments.closed.bytes as number,
    );
  });

  it('inbox_events: max(deliveries) を測る', async () => {
    await db.insert(inboxEvents).values([
      {
        id: 'ev-1',
        event: {
          type: 'human_message',
          id: 'ev-1',
          at: '2026-09-20T00:00:00.000Z',
          text: 'hi',
          conversationId: 'c1',
        },
        at: new Date('2026-09-20T00:00:00.000Z'),
        deliveries: 2,
      },
      {
        id: 'ev-2',
        event: {
          type: 'human_message',
          id: 'ev-2',
          at: '2026-09-20T00:00:00.000Z',
          text: 'yo',
          conversationId: 'c1',
        },
        at: new Date('2026-09-20T00:00:00.000Z'),
        deliveries: 7,
      },
    ]);

    const footprint = await measureStorageFootprint(db);
    expect(footprint.inboxEvents.rows).toBe(2);
    expect(footprint.inboxEvents.maxDeliveries).toBe(7);
  });

  it('journal: 全体と直近3日を別々に数える', async () => {
    const now = new Date();
    const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    await db.insert(journal).values([
      {
        id: 'j-old',
        at: fourDaysAgo,
        type: 'decision',
        entry: {
          type: 'decision',
          id: 'j-old',
          at: fourDaysAgo.toISOString(),
          decision: 'd',
          grounds: 'g'.repeat(500),
        },
      },
      {
        id: 'j-new',
        at: oneDayAgo,
        type: 'decision',
        entry: {
          type: 'decision',
          id: 'j-new',
          at: oneDayAgo.toISOString(),
          decision: 'd',
          grounds: 'g'.repeat(500),
        },
      },
    ]);

    const footprint = await measureStorageFootprint(db);
    expect(footprint.journal.all.rows).toBe(2);
    expect(footprint.journal.recent3d.rows).toBe(1);
    expect(footprint.journal.all.bytes as number).toBeGreaterThan(
      footprint.journal.recent3d.bytes as number,
    );
  });

  it('archive: text 列も pg_column_size で測る', async () => {
    await db.insert(archive).values({
      id: 'sess-1.jsonl',
      sessionId: 'sess-1',
      at: new Date('2026-09-20T00:00:00.000Z'),
      body: randomBody(3_000),
    });

    const footprint = await measureStorageFootprint(db);
    expect(footprint.archive.rows).toBe(1);
    expect(footprint.archive.bytes as number).toBeGreaterThan(2_900);
    expect(footprint.archive.maxBytes).toBe(footprint.archive.bytes);
  });
});

describe('measureStorageFootprint（本文を1バイトも SELECT しない）', () => {
  /**
   * 撃った SQL そのもので見る（`session-store.ts` の `measureSize` のテストと
   * 同じ形）。`pg_column_size(...)` の呼び出しを取り除いた残りに、本文の列名
   * （`job` / `commitment` / `event` / `entry` / `body`）が**列参照として**
   * 残っていなければ、その列は集約関数の外で参照されていない。
   *
   * **列名の単純な部分文字列一致は使わない。** `"jobs"` は `"job"` を部分文字列
   * として含まないが（末尾が `s"` で終わるため）、念のため `-- ` で区切って
   * SQL の識別子境界に寄せた形（`"<列名>"`）で判定する。
   */
  it('5本の SQL は、対応する本文の列を pg_column_size(...) の中でしか参照しない', async () => {
    const queries: string[] = [];
    const loggingDb = drizzle(client, {
      logger: { logQuery: (query: string) => queries.push(query) },
    });

    await measureStorageFootprint(loggingDb);

    // jobs / commitments / inbox_events / journal / archive の5クエリ。
    expect(queries).toHaveLength(5);

    const bodyColumnOf = (query: string): string | undefined => {
      if (query.includes('from "jobs"')) return 'job';
      if (query.includes('from "commitments"')) return 'commitment';
      if (query.includes('from "inbox_events"')) return 'event';
      if (query.includes('from "journal"')) return 'entry';
      if (query.includes('from "archive"')) return 'body';
      return undefined;
    };

    const seen = new Set<string>();
    for (const query of queries) {
      const column = bodyColumnOf(query);
      expect(column, `未知のクエリ（対象の表を特定できない）: ${query}`).toBeDefined();
      seen.add(column as string);

      const withoutSizeCalls = query.replace(/pg_column_size\([^)]*\)/gi, '');
      expect(withoutSizeCalls).not.toContain(`"${column}"`);
    }
    // 5表すべてが実際に撃たれたことも確認する（取りこぼしが無いこと）。
    expect(seen).toEqual(new Set(['job', 'commitment', 'event', 'entry', 'body']));
  });
});

describe('measureStorageFootprint（測定は起動を止めない・表ごとに独立して倒れる）', () => {
  it('1表が測れなくても（表が無い等）、他の表は測り続け、関数自体は投げない', async () => {
    // journal だけ落とす——「クエリが投げる」状況を、モックではなく実際に作る。
    await db.execute(sql`drop table journal`);

    const footprint = await measureStorageFootprint(db);

    // journal は測れなかった（null）。
    expect(footprint.journal).toEqual({
      all: { rows: null, bytes: null },
      recent3d: { rows: null, bytes: null },
    });
    // 他の4表は無事——「journal が落ちた」が伝播していない。
    expect(footprint.jobs).toEqual({ rows: 0, bytes: 0, maxBytes: 0 });
    expect(footprint.commitments).toEqual({
      open: { rows: 0, bytes: 0, maxBytes: 0 },
      closed: { rows: 0, bytes: 0, maxBytes: 0 },
    });
    expect(footprint.inboxEvents).toEqual({ rows: 0, bytes: 0, maxBytes: 0, maxDeliveries: 0 });
    expect(footprint.archive).toEqual({ rows: 0, bytes: 0, maxBytes: 0 });
  });

  it('複数の表が同時に測れなくても、残りは測り続ける', async () => {
    await db.execute(sql`drop table journal`);
    await db.execute(sql`drop table archive`);

    const footprint = await measureStorageFootprint(db);

    expect(footprint.journal.all.rows).toBeNull();
    expect(footprint.archive.rows).toBeNull();
    expect(footprint.jobs.rows).toBe(0);
    expect(footprint.commitments.open.rows).toBe(0);
    expect(footprint.inboxEvents.rows).toBe(0);
  });
});
