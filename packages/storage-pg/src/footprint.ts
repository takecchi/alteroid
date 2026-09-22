import { sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { toNumber } from './db.js';
import { archive, commitments, inboxEvents, jobs, journal } from './schema.js';

/**
 * 起動時の器の実寸とヒープの検知（#1283 の続き。段2）。
 *
 * #1284（`main` の `0070f92`）が、起動時に上限なしで `jsonb` 本文を全行読む口を
 * 1つ（`session_entries`）塞いだ。**その調査で、同じ形の口が #1283 のリストの
 * 外にもう2つ見つかっている**——`jobs.listJobs()`（冷たい起動では全行 stale に
 * なり、段2が `LIMIT` 無しの `SELECT id, job FROM jobs` に落ちる）と
 * `commitments.list({ includeClosed: true })`（`commitments.ts` の `list()` の
 * doc「pg 版は片付いた行を物理削除する経路を1つも持たない」——片付いた行を
 * 本文ごと全件読み、単調に伸び続ける）。
 *
 * ⟹ 問題は「上限なしの口が何個あるか」ではなく、**「単調に伸び続け・削除経路を
 * 持たず・全件を本文ごと読む表が複数ある」という構造**である。**この構造そのもの
 * を塞ぐ実装はここには無い**——⛔ この PR は何も直していない（既存の口を1つも
 * 塞いでいない）。塞ぐ前に、まず「起動した瞬間、その表は実際に何バイトなのか」を
 * 毎回の起動で見えるようにする。落ちた後には読めない値なので、**落ちる瞬間の
 * ログと、起動1回につき1行の日誌の両方に残す**（呼び出し側は
 * `apps/daemon/src/storage.ts` の `openStorage()`。ヒープの実測とその2つの出し先は
 * `apps/daemon/src/boot-footprint.ts` が持つ——ここは pg の表を測るところまで）。
 *
 * ## 契約（`session-store.ts` の `measureSize` と同じ形。踏襲している）
 *
 * - **本文（`jsonb` / `text` 列）を1バイトも SELECT しない。** 見るのは
 *   `count(*)` と `sum(pg_column_size(col))` と `max(pg_column_size(col))` だけ
 *   ——`pg_column_size` は行内に収まった TOAST ポインタのサイズだけを見て、
 *   外部チャンクを取りに行かない（`archive.ts` の `list()` / `session-store.ts`
 *   の `measureSize` と同じ理由・同じ関数）。本文は1バイトも Node のメモリへ
 *   載らない。
 * - **測れなかった（クエリが投げた）は `null`。実測して0行／0バイトは `0`。
 *   型で区別する**（AGENTS.md 地雷表「取れない軸に 0 の行を作る」——値を作らず、
 *   取れない理由を出力に残す側へ倒す）。集約関数（`sum` / `max`）は対象が0行
 *   だと SQL の `NULL` を返す——それは「測れなかった」ではなく「実測して0
 *   （該当する行が無かった）」なので `0` にする（`session-store.ts` の
 *   `measureSize` の doc「行が無い鍵は `sum(...)` が SQL の `NULL` を返す。
 *   それは『測れなかった』ではなく『測って0バイトだった』」と同じ判断）。
 * - **測定は起動を止めない。** 表ごとに独立した `try`/`catch` に包んであり、
 *   1つの表の測定が投げても他の表・呼び出し元へは伝播しない。この
 *   `measureStorageFootprint` 自体も throw しない——内部の `await` は全部、
 *   個別の `measure*Footprint` が持つ独立した `catch` の中にある。
 */

/** 1つの表（または表の中の1区分）ぶんの実寸。 */
export interface TableSizeStats {
  /** 行数。測れなかったら `null`。実測して0行なら `0`。 */
  rows: number | null;
  /** `pg_column_size(...)` の合計バイト数。測れなかったら `null`。 */
  bytes: number | null;
  /** `pg_column_size(...)` の最大値（最大1行のバイト数）。測れなかったら `null`。 */
  maxBytes: number | null;
}

/** `jobs`（ジョブ台帳。`jobs.listJobs()` が上限なしで読む表）。 */
export type JobsFootprint = TableSizeStats;

/** `commitments`（未了 / 片付き、状態ごとに独立して測る）。 */
export interface CommitmentsFootprint {
  /** `closed_at is null`（未了）。 */
  open: TableSizeStats;
  /** `closed_at is not null`（片付き。物理削除の経路が無いので伸び続ける）。 */
  closed: TableSizeStats;
}

/** `inbox_events`。 */
export interface InboxEventsFootprint extends TableSizeStats {
  /** `max(deliveries)`。測れなかったら `null`。実測して対象0行なら `0`。 */
  maxDeliveries: number | null;
}

/** `journal` の窓1つぶん（行数・合計バイトのみ。`maxBytes` は測っていない）。 */
export interface JournalWindowStats {
  rows: number | null;
  bytes: number | null;
}

/** `journal`（全体 / 直近3日、窓ごとに独立して測る）。 */
export interface JournalFootprint {
  all: JournalWindowStats;
  /** `at >= now() - interval '3 days'`。 */
  recent3d: JournalWindowStats;
}

/** `archive`（`body` は `text` 列。`pg_column_size` は text にも使える）。 */
export type ArchiveFootprint = TableSizeStats;

/** 起動時に測る表ぶんの実寸をまとめたもの。 */
export interface StorageFootprint {
  jobs: JobsFootprint;
  commitments: CommitmentsFootprint;
  inboxEvents: InboxEventsFootprint;
  journal: JournalFootprint;
  archive: ArchiveFootprint;
}

/** 測れなかった（クエリが投げた）ときの `TableSizeStats`。全欄 `null`。 */
const UNMEASURABLE: TableSizeStats = { rows: null, bytes: null, maxBytes: null };

/** SQL の `NULL`（集約対象が0行）を「実測して0」として数値化する。 */
function zeroIfNull(value: number | string | null): number | null {
  return value === null ? 0 : toNumber(value);
}

async function measureJobsFootprint(db: Db): Promise<JobsFootprint> {
  try {
    const [row] = await db
      .select({
        rows: sql<number | string>`count(*)`,
        bytes: sql<number | string | null>`sum(pg_column_size(${jobs.job}))`,
        maxBytes: sql<number | string | null>`max(pg_column_size(${jobs.job}))`,
      })
      .from(jobs);
    if (row === undefined) return { rows: 0, bytes: 0, maxBytes: 0 };
    return {
      rows: toNumber(row.rows),
      bytes: zeroIfNull(row.bytes),
      maxBytes: zeroIfNull(row.maxBytes),
    };
  } catch {
    return { ...UNMEASURABLE };
  }
}

async function measureCommitmentsFootprint(db: Db): Promise<CommitmentsFootprint> {
  try {
    const [row] = await db
      .select({
        openRows: sql<number | string>`count(*) filter (where ${commitments.closedAt} is null)`,
        openBytes: sql<
          number | string | null
        >`sum(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is null)`,
        openMaxBytes: sql<
          number | string | null
        >`max(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is null)`,
        closedRows: sql<
          number | string
        >`count(*) filter (where ${commitments.closedAt} is not null)`,
        closedBytes: sql<
          number | string | null
        >`sum(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is not null)`,
        closedMaxBytes: sql<
          number | string | null
        >`max(pg_column_size(${commitments.commitment})) filter (where ${commitments.closedAt} is not null)`,
      })
      .from(commitments);
    if (row === undefined) {
      return {
        open: { rows: 0, bytes: 0, maxBytes: 0 },
        closed: { rows: 0, bytes: 0, maxBytes: 0 },
      };
    }
    return {
      open: {
        rows: toNumber(row.openRows),
        bytes: zeroIfNull(row.openBytes),
        maxBytes: zeroIfNull(row.openMaxBytes),
      },
      closed: {
        rows: toNumber(row.closedRows),
        bytes: zeroIfNull(row.closedBytes),
        maxBytes: zeroIfNull(row.closedMaxBytes),
      },
    };
  } catch {
    return { open: { ...UNMEASURABLE }, closed: { ...UNMEASURABLE } };
  }
}

async function measureInboxEventsFootprint(db: Db): Promise<InboxEventsFootprint> {
  try {
    const [row] = await db
      .select({
        rows: sql<number | string>`count(*)`,
        bytes: sql<number | string | null>`sum(pg_column_size(${inboxEvents.event}))`,
        maxBytes: sql<number | string | null>`max(pg_column_size(${inboxEvents.event}))`,
        maxDeliveries: sql<number | string | null>`max(${inboxEvents.deliveries})`,
      })
      .from(inboxEvents);
    if (row === undefined) return { rows: 0, bytes: 0, maxBytes: 0, maxDeliveries: 0 };
    return {
      rows: toNumber(row.rows),
      bytes: zeroIfNull(row.bytes),
      maxBytes: zeroIfNull(row.maxBytes),
      maxDeliveries: zeroIfNull(row.maxDeliveries),
    };
  } catch {
    return { ...UNMEASURABLE, maxDeliveries: null };
  }
}

async function measureJournalFootprint(db: Db): Promise<JournalFootprint> {
  try {
    const [row] = await db
      .select({
        allRows: sql<number | string>`count(*)`,
        allBytes: sql<number | string | null>`sum(pg_column_size(${journal.entry}))`,
        recentRows: sql<
          number | string
        >`count(*) filter (where ${journal.at} >= now() - interval '3 days')`,
        recentBytes: sql<
          number | string | null
        >`sum(pg_column_size(${journal.entry})) filter (where ${journal.at} >= now() - interval '3 days')`,
      })
      .from(journal);
    if (row === undefined) {
      return { all: { rows: 0, bytes: 0 }, recent3d: { rows: 0, bytes: 0 } };
    }
    return {
      all: { rows: toNumber(row.allRows), bytes: zeroIfNull(row.allBytes) },
      recent3d: { rows: toNumber(row.recentRows), bytes: zeroIfNull(row.recentBytes) },
    };
  } catch {
    return {
      all: { rows: null, bytes: null },
      recent3d: { rows: null, bytes: null },
    };
  }
}

async function measureArchiveFootprint(db: Db): Promise<ArchiveFootprint> {
  try {
    const [row] = await db
      .select({
        rows: sql<number | string>`count(*)`,
        bytes: sql<number | string | null>`sum(pg_column_size(${archive.body}))`,
        maxBytes: sql<number | string | null>`max(pg_column_size(${archive.body}))`,
      })
      .from(archive);
    if (row === undefined) return { rows: 0, bytes: 0, maxBytes: 0 };
    return {
      rows: toNumber(row.rows),
      bytes: zeroIfNull(row.bytes),
      maxBytes: zeroIfNull(row.maxBytes),
    };
  } catch {
    return { ...UNMEASURABLE };
  }
}

/**
 * 起動時の器の実寸を測る（#1283、段2）。**本文を1バイトも SELECT しない。**
 *
 * 5つの表（区分）を独立に測る——1つが投げても他は測り続ける（上のファイル doc
 * 「測定は起動を止めない」）。`Promise.all` で束ねているのは並行に撃つためで、
 * 失敗の伝播とは無関係——各 `measure*Footprint` は自分の `try`/`catch` の中で
 * 必ず解決し、reject しない（この関数自体も reject しない）。
 */
export async function measureStorageFootprint(db: Db): Promise<StorageFootprint> {
  const [
    jobsFootprint,
    commitmentsFootprint,
    inboxEventsFootprint,
    journalFootprint,
    archiveFootprint,
  ] = await Promise.all([
    measureJobsFootprint(db),
    measureCommitmentsFootprint(db),
    measureInboxEventsFootprint(db),
    measureJournalFootprint(db),
    measureArchiveFootprint(db),
  ]);
  return {
    jobs: jobsFootprint,
    commitments: commitmentsFootprint,
    inboxEvents: inboxEventsFootprint,
    journal: journalFootprint,
    archive: archiveFootprint,
  };
}
