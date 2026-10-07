import { sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { toNumber } from './db.js';
import { archive, commitments, inboxEvents, jobs, journal } from './schema.js';

export const STATEMENT_TIMEOUT_MS = 3000;

export interface TableSizeStats {
  rows: number | null;
  // 閾値の比較に使わない: 圧縮後の格納バイトで、圧縮が効く本文では実テキストを大きく下回るため。`textBytes` で比べる。
  storedBytes: number | null;
  textBytes: number | null;
  maxStoredBytes: number | null;
  maxTextBytes: number | null;
}

export type JobsFootprint = TableSizeStats;

export interface CommitmentsFootprint {
  open: TableSizeStats;
  closed: TableSizeStats;
}

export interface InboxEventsFootprint extends TableSizeStats {
  maxDeliveries: number | null;
}

export interface JournalWindowStats {
  rows: number | null;
  storedBytes: number | null;
  textBytes: number | null;
}

export interface JournalFootprint {
  all: JournalWindowStats;
  recent3d: JournalWindowStats;
}

export type ArchiveFootprint = TableSizeStats;

export interface StorageFootprint {
  jobs: JobsFootprint;
  commitments: CommitmentsFootprint;
  inboxEvents: InboxEventsFootprint;
  journal: JournalFootprint;
  archive: ArchiveFootprint;
  measurementMs: number;
}

const UNMEASURABLE: TableSizeStats = {
  rows: null,
  storedBytes: null,
  textBytes: null,
  maxStoredBytes: null,
  maxTextBytes: null,
};

function zeroIfNull(value: number | string | null): number | null {
  return value === null ? 0 : toNumber(value);
}

// `SET LOCAL` を使わない: `SET` はプレースホルダを受け付けないため、`set_config(..., true)` で同じ効果を得る。
export async function withStatementTimeout<T>(
  db: Db,
  statementTimeoutMs: number,
  body: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`,
    );
    return body(tx);
  });
}

async function measureJobsFootprint(db: Db, statementTimeoutMs: number): Promise<JobsFootprint> {
  try {
    return await withStatementTimeout(db, statementTimeoutMs, async (tx) => {
      const [row] = await tx
        .select({
          rows: sql<number | string>`count(*)`,
          storedBytes: sql<number | string | null>`sum(pg_column_size(${jobs.job}))`,
          textBytes: sql<number | string | null>`sum(octet_length(${jobs.job}::text))`,
          maxStoredBytes: sql<number | string | null>`max(pg_column_size(${jobs.job}))`,
          maxTextBytes: sql<number | string | null>`max(octet_length(${jobs.job}::text))`,
        })
        .from(jobs);
      if (row === undefined) {
        return { rows: 0, storedBytes: 0, textBytes: 0, maxStoredBytes: 0, maxTextBytes: 0 };
      }
      return {
        rows: toNumber(row.rows),
        storedBytes: zeroIfNull(row.storedBytes),
        textBytes: zeroIfNull(row.textBytes),
        maxStoredBytes: zeroIfNull(row.maxStoredBytes),
        maxTextBytes: zeroIfNull(row.maxTextBytes),
      };
    });
  } catch {
    return { ...UNMEASURABLE };
  }
}

async function measureCommitmentsFootprint(
  db: Db,
  statementTimeoutMs: number,
): Promise<CommitmentsFootprint> {
  try {
    return await withStatementTimeout(db, statementTimeoutMs, async (tx) => {
      const [row] = await tx
        .select({
          openRows: sql<number | string>`count(*) filter (where ${commitments.closedAt} is null)`,
          openStoredBytes: sql<
            number | string | null
          >`sum(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is null)`,
          openTextBytes: sql<
            number | string | null
          >`sum(octet_length(${commitments.commitment}::text)) filter (where ${commitments.closedAt} is null)`,
          openMaxStoredBytes: sql<
            number | string | null
          >`max(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is null)`,
          openMaxTextBytes: sql<
            number | string | null
          >`max(octet_length(${commitments.commitment}::text)) filter (where ${commitments.closedAt} is null)`,
          closedRows: sql<
            number | string
          >`count(*) filter (where ${commitments.closedAt} is not null)`,
          closedStoredBytes: sql<
            number | string | null
          >`sum(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is not null)`,
          closedTextBytes: sql<
            number | string | null
          >`sum(octet_length(${commitments.commitment}::text)) filter (where ${commitments.closedAt} is not null)`,
          closedMaxStoredBytes: sql<
            number | string | null
          >`max(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is not null)`,
          closedMaxTextBytes: sql<
            number | string | null
          >`max(octet_length(${commitments.commitment}::text)) filter (where ${commitments.closedAt} is not null)`,
        })
        .from(commitments);
      if (row === undefined) {
        return {
          open: { rows: 0, storedBytes: 0, textBytes: 0, maxStoredBytes: 0, maxTextBytes: 0 },
          closed: { rows: 0, storedBytes: 0, textBytes: 0, maxStoredBytes: 0, maxTextBytes: 0 },
        };
      }
      return {
        open: {
          rows: toNumber(row.openRows),
          storedBytes: zeroIfNull(row.openStoredBytes),
          textBytes: zeroIfNull(row.openTextBytes),
          maxStoredBytes: zeroIfNull(row.openMaxStoredBytes),
          maxTextBytes: zeroIfNull(row.openMaxTextBytes),
        },
        closed: {
          rows: toNumber(row.closedRows),
          storedBytes: zeroIfNull(row.closedStoredBytes),
          textBytes: zeroIfNull(row.closedTextBytes),
          maxStoredBytes: zeroIfNull(row.closedMaxStoredBytes),
          maxTextBytes: zeroIfNull(row.closedMaxTextBytes),
        },
      };
    });
  } catch {
    return { open: { ...UNMEASURABLE }, closed: { ...UNMEASURABLE } };
  }
}

async function measureInboxEventsFootprint(
  db: Db,
  statementTimeoutMs: number,
): Promise<InboxEventsFootprint> {
  try {
    return await withStatementTimeout(db, statementTimeoutMs, async (tx) => {
      const [row] = await tx
        .select({
          rows: sql<number | string>`count(*)`,
          storedBytes: sql<number | string | null>`sum(pg_column_size(${inboxEvents.event}))`,
          textBytes: sql<number | string | null>`sum(octet_length(${inboxEvents.event}::text))`,
          maxStoredBytes: sql<number | string | null>`max(pg_column_size(${inboxEvents.event}))`,
          maxTextBytes: sql<number | string | null>`max(octet_length(${inboxEvents.event}::text))`,
          maxDeliveries: sql<number | string | null>`max(${inboxEvents.deliveries})`,
        })
        .from(inboxEvents);
      if (row === undefined) {
        return {
          rows: 0,
          storedBytes: 0,
          textBytes: 0,
          maxStoredBytes: 0,
          maxTextBytes: 0,
          maxDeliveries: 0,
        };
      }
      return {
        rows: toNumber(row.rows),
        storedBytes: zeroIfNull(row.storedBytes),
        textBytes: zeroIfNull(row.textBytes),
        maxStoredBytes: zeroIfNull(row.maxStoredBytes),
        maxTextBytes: zeroIfNull(row.maxTextBytes),
        maxDeliveries: zeroIfNull(row.maxDeliveries),
      };
    });
  } catch {
    return { ...UNMEASURABLE, maxDeliveries: null };
  }
}

async function measureJournalFootprint(
  db: Db,
  statementTimeoutMs: number,
): Promise<JournalFootprint> {
  try {
    return await withStatementTimeout(db, statementTimeoutMs, async (tx) => {
      const [row] = await tx
        .select({
          allRows: sql<number | string>`count(*)`,
          allStoredBytes: sql<number | string | null>`sum(pg_column_size(${journal.entry}))`,
          allTextBytes: sql<number | string | null>`sum(octet_length(${journal.entry}::text))`,
          recentRows: sql<
            number | string
          >`count(*) filter (where ${journal.at} >= now() - interval '3 days')`,
          recentStoredBytes: sql<
            number | string | null
          >`sum(pg_column_size(${journal.entry})) filter (where ${journal.at} >= now() - interval '3 days')`,
          recentTextBytes: sql<
            number | string | null
          >`sum(octet_length(${journal.entry}::text)) filter (where ${journal.at} >= now() - interval '3 days')`,
        })
        .from(journal);
      if (row === undefined) {
        return {
          all: { rows: 0, storedBytes: 0, textBytes: 0 },
          recent3d: { rows: 0, storedBytes: 0, textBytes: 0 },
        };
      }
      return {
        all: {
          rows: toNumber(row.allRows),
          storedBytes: zeroIfNull(row.allStoredBytes),
          textBytes: zeroIfNull(row.allTextBytes),
        },
        recent3d: {
          rows: toNumber(row.recentRows),
          storedBytes: zeroIfNull(row.recentStoredBytes),
          textBytes: zeroIfNull(row.recentTextBytes),
        },
      };
    });
  } catch {
    return {
      all: { rows: null, storedBytes: null, textBytes: null },
      recent3d: { rows: null, storedBytes: null, textBytes: null },
    };
  }
}

async function measureArchiveFootprint(
  db: Db,
  statementTimeoutMs: number,
): Promise<ArchiveFootprint> {
  try {
    return await withStatementTimeout(db, statementTimeoutMs, async (tx) => {
      const [row] = await tx
        .select({
          rows: sql<number | string>`count(*)`,
          storedBytes: sql<number | string | null>`sum(pg_column_size(${archive.body}))`,
          textBytes: sql<number | string | null>`sum(octet_length(${archive.body}::text))`,
          maxStoredBytes: sql<number | string | null>`max(pg_column_size(${archive.body}))`,
          maxTextBytes: sql<number | string | null>`max(octet_length(${archive.body}::text))`,
        })
        .from(archive);
      if (row === undefined) {
        return { rows: 0, storedBytes: 0, textBytes: 0, maxStoredBytes: 0, maxTextBytes: 0 };
      }
      return {
        rows: toNumber(row.rows),
        storedBytes: zeroIfNull(row.storedBytes),
        textBytes: zeroIfNull(row.textBytes),
        maxStoredBytes: zeroIfNull(row.maxStoredBytes),
        maxTextBytes: zeroIfNull(row.maxTextBytes),
      };
    });
  } catch {
    return { ...UNMEASURABLE };
  }
}

// 測定の失敗を投げない: 起動を止めないため。各 `measure*Footprint` が自分の `try`/`catch` で `null` に倒す。
export async function measureStorageFootprint(
  db: Db,
  statementTimeoutMs: number = STATEMENT_TIMEOUT_MS,
): Promise<StorageFootprint> {
  const startedAt = Date.now();
  const [
    jobsFootprint,
    commitmentsFootprint,
    inboxEventsFootprint,
    journalFootprint,
    archiveFootprint,
  ] = await Promise.all([
    measureJobsFootprint(db, statementTimeoutMs),
    measureCommitmentsFootprint(db, statementTimeoutMs),
    measureInboxEventsFootprint(db, statementTimeoutMs),
    measureJournalFootprint(db, statementTimeoutMs),
    measureArchiveFootprint(db, statementTimeoutMs),
  ]);
  return {
    jobs: jobsFootprint,
    commitments: commitmentsFootprint,
    inboxEvents: inboxEventsFootprint,
    journal: journalFootprint,
    archive: archiveFootprint,
    measurementMs: Date.now() - startedAt,
  };
}
