import { randomBytes } from 'node:crypto';

import type { Commitment } from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { measureStorageFootprint, STATEMENT_TIMEOUT_MS, type TableSizeStats } from './footprint.js';
import { archive, commitments, inboxEvents, jobs, journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// `'x'.repeat(n)` を使わない: 圧縮率が高すぎて、長さを変えても `pg_column_size` がほぼ変わらないため。乱数の16進文字列を使う。
function randomBody(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString('hex')
    .slice(0, chars);
}

function compressiblePhrase(repeatCount: number): string {
  return '約束の台帳の手順・禁止領域について、この記録は同じ文面を繰り返す傾向がある。'.repeat(
    repeatCount,
  );
}

function emptyStats(): TableSizeStats {
  return { rows: 0, storedBytes: 0, textBytes: 0, maxStoredBytes: 0, maxTextBytes: 0 };
}

function emptyJournalWindow(): { rows: number; storedBytes: number; textBytes: number } {
  return { rows: 0, storedBytes: 0, textBytes: 0 };
}

// 打ち切りの発火を歯にしない: PGlite では `statement_timeout` が実際には打ち切らないため、設定する SQL が撃たれること（配線）と、投げたとき表が独立して `null` に倒れることだけを見る。
let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

describe('measureStorageFootprint（空の DB）', () => {
  it('5つの表すべてで「実測して0」——nullではない', async () => {
    const footprint = await measureStorageFootprint(db);

    expect(footprint.jobs).toEqual(emptyStats());
    expect(footprint.commitments).toEqual({ open: emptyStats(), closed: emptyStats() });
    expect(footprint.inboxEvents).toEqual({ ...emptyStats(), maxDeliveries: 0 });
    expect(footprint.journal).toEqual({
      all: emptyJournalWindow(),
      recent3d: emptyJournalWindow(),
    });
    expect(footprint.archive).toEqual(emptyStats());
  });

  it('measurementMs は非負の実測値', async () => {
    const footprint = await measureStorageFootprint(db);
    expect(footprint.measurementMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(footprint.measurementMs)).toBe(true);
  });
});

describe('measureStorageFootprint（積んだぶんだけ増える）', () => {
  it('jobs: 行数と storedBytes/textBytes が増える', async () => {
    const before = await measureStorageFootprint(db);
    expect(before.jobs).toEqual(emptyStats());

    await db.insert(jobs).values({
      id: 'job-1',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { body: randomBody(1_000) },
    });
    const afterOne = await measureStorageFootprint(db);
    expect(afterOne.jobs.rows).toBe(1);
    expect(afterOne.jobs.storedBytes).not.toBeNull();
    expect(afterOne.jobs.textBytes).not.toBeNull();
    expect(afterOne.jobs.storedBytes as number).toBeGreaterThan(900);
    expect(afterOne.jobs.textBytes as number).toBeGreaterThan(900);
    expect(afterOne.jobs.maxStoredBytes).toBe(afterOne.jobs.storedBytes);
    expect(afterOne.jobs.maxTextBytes).toBe(afterOne.jobs.textBytes);

    await db.insert(jobs).values({
      id: 'job-2',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { body: randomBody(5_000) },
    });
    const afterTwo = await measureStorageFootprint(db);
    expect(afterTwo.jobs.rows).toBe(2);
    expect(afterTwo.jobs.storedBytes as number).toBeGreaterThan(
      afterOne.jobs.storedBytes as number,
    );
    expect(afterTwo.jobs.textBytes as number).toBeGreaterThan(afterOne.jobs.textBytes as number);
    expect(afterTwo.jobs.maxStoredBytes as number).toBeGreaterThan(
      afterOne.jobs.maxStoredBytes as number,
    );
    expect(afterTwo.jobs.maxTextBytes as number).toBeGreaterThan(
      afterOne.jobs.maxTextBytes as number,
    );
  });

  it('commitments: 未了と片付きは独立して数える（storedBytes/textBytes とも）', async () => {
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
    expect(footprint.commitments.open.storedBytes as number).toBeGreaterThan(900);
    expect(footprint.commitments.open.textBytes as number).toBeGreaterThan(900);
    expect(footprint.commitments.closed.storedBytes as number).toBeGreaterThan(1_900);
    expect(footprint.commitments.closed.textBytes as number).toBeGreaterThan(1_900);
    expect(footprint.commitments.open.storedBytes as number).toBeLessThan(
      footprint.commitments.closed.storedBytes as number,
    );
    expect(footprint.commitments.open.textBytes as number).toBeLessThan(
      footprint.commitments.closed.textBytes as number,
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

  it('journal: 全体と直近3日を別々に数える（storedBytes/textBytes とも）', async () => {
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
          grounds: randomBody(500),
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
          grounds: randomBody(500),
        },
      },
    ]);

    const footprint = await measureStorageFootprint(db);
    expect(footprint.journal.all.rows).toBe(2);
    expect(footprint.journal.recent3d.rows).toBe(1);
    expect(footprint.journal.all.storedBytes as number).toBeGreaterThan(
      footprint.journal.recent3d.storedBytes as number,
    );
    expect(footprint.journal.all.textBytes as number).toBeGreaterThan(
      footprint.journal.recent3d.textBytes as number,
    );
  });

  it('archive: text 列も pg_column_size / octet_length で測る', async () => {
    await db.insert(archive).values({
      id: 'sess-1.jsonl',
      sessionId: 'sess-1',
      at: new Date('2026-09-20T00:00:00.000Z'),
      body: randomBody(3_000),
    });

    const footprint = await measureStorageFootprint(db);
    expect(footprint.archive.rows).toBe(1);
    expect(footprint.archive.storedBytes as number).toBeGreaterThan(2_900);
    expect(footprint.archive.textBytes as number).toBeGreaterThan(2_900);
    expect(footprint.archive.maxStoredBytes).toBe(footprint.archive.storedBytes);
    expect(footprint.archive.maxTextBytes).toBe(footprint.archive.textBytes);
  });
});

describe('measureStorageFootprint（storedBytes と textBytes は別物——圧縮が効く本文で大きく食い違う）', () => {
  it('日本語の定型文の繰り返し（alteroid の実際の本文に近い形）では、storedBytes は textBytes を大きく下回る', async () => {
    await db.insert(jobs).values({
      id: 'job-compressible',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { note: compressiblePhrase(4000) },
    });

    const footprint = await measureStorageFootprint(db);
    const { storedBytes, textBytes } = footprint.jobs;
    expect(storedBytes).not.toBeNull();
    expect(textBytes).not.toBeNull();

    expect(textBytes as number).toBeGreaterThan(400_000);
    expect(storedBytes as number).toBeLessThan(10_000);

    expect(textBytes as number).toBeGreaterThan((storedBytes as number) * 10);
  });

  it('⭐ 陰性対照——圧縮の効かない本文（乱数）では、storedBytes と textBytes はほぼ一致する', async () => {
    await db.insert(jobs).values({
      id: 'job-incompressible',
      status: 'queued',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      job: { note: randomBody(20_000) },
    });

    const footprint = await measureStorageFootprint(db);
    const { storedBytes, textBytes } = footprint.jobs;
    expect(storedBytes).not.toBeNull();
    expect(textBytes).not.toBeNull();
    expect(textBytes as number).toBeLessThan((storedBytes as number) * 2);
  });
});

describe('measureStorageFootprint（本文は Node のメモリへ載せない）', () => {
  it('5表分の SELECT は、本文の列を pg_column_size(...) / octet_length(...::text) の中でしか参照しない', async () => {
    const queries: string[] = [];
    const loggingDb = client.withLogger({ logQuery: (query: string) => queries.push(query) });

    await measureStorageFootprint(loggingDb);

    const bodyColumnOf = (query: string): string | undefined => {
      if (query.includes('from "jobs"')) return 'job';
      if (query.includes('from "commitments"')) return 'commitment';
      if (query.includes('from "inbox_events"')) return 'event';
      if (query.includes('from "journal"')) return 'entry';
      if (query.includes('from "archive"')) return 'body';
      return undefined;
    };

    const selectQueries = queries.filter((q) => bodyColumnOf(q) !== undefined);
    expect(selectQueries).toHaveLength(5);

    const seen = new Set<string>();
    for (const query of selectQueries) {
      const column = bodyColumnOf(query) as string;
      seen.add(column);

      const withoutSizeAndLengthCalls = query
        .replace(/pg_column_size\([^)]*\)/gi, '')
        .replace(/octet_length\([^)]*\)/gi, '');
      expect(withoutSizeAndLengthCalls, query).not.toContain(`"${column}"`);
    }
    expect(seen).toEqual(new Set(['job', 'commitment', 'event', 'entry', 'body']));
  });

  it("5表それぞれの測定が set_config('statement_timeout', …) を撃っている（配線の確認）", async () => {
    const queries: string[] = [];
    const loggingDb = client.withLogger({ logQuery: (query: string) => queries.push(query) });

    await measureStorageFootprint(loggingDb, STATEMENT_TIMEOUT_MS);

    const timeoutQueries = queries.filter((q) => q.includes("set_config('statement_timeout'"));
    expect(timeoutQueries).toHaveLength(5);
  });
});

describe('measureStorageFootprint（測定は起動を止めない・表ごとに独立して倒れる）', () => {
  it('1表が測れなくても（表が無い等）、他の表は測り続け、関数自体は投げない', async () => {
    await db.execute(sql`drop table journal`);

    const footprint = await measureStorageFootprint(db);

    expect(footprint.journal).toEqual({
      all: { rows: null, storedBytes: null, textBytes: null },
      recent3d: { rows: null, storedBytes: null, textBytes: null },
    });
    expect(footprint.jobs).toEqual(emptyStats());
    expect(footprint.commitments).toEqual({ open: emptyStats(), closed: emptyStats() });
    expect(footprint.inboxEvents).toEqual({ ...emptyStats(), maxDeliveries: 0 });
    expect(footprint.archive).toEqual(emptyStats());
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
