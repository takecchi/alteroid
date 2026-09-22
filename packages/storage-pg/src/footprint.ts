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
 * ## ⚠️ 訂正の記録 — `pg_column_size` は「ポインタのサイズだけ」ではない
 *
 * この doc は当初「`pg_column_size` は行内に収まった TOAST ポインタのサイズ
 * だけを見て、外部チャンクを取りに行かない」と書いていた。**これは誤りである。**
 * レビューで本物の PostgreSQL 17（`.claude/skills/postgres-in-container/`）を
 * 立てて実測したところ、`pg_column_size` は**圧縮後の格納バイト数**を返しており
 * （TOAST されて外部へ出た値の生チャンクは確かに読みに行かないが、圧縮そのもの
 * は展開せずにサイズだけ見ている、という主張が誤りだった——実際には圧縮された
 * 状態のサイズをそのまま返す。「展開しない」は正しいが「ポインタのサイズだけ」
 * は正しくない）。**圧縮が効く本文（alteroid が実際に貯めている、日本語の定型文
 * が多い本文）では、実際のテキストサイズを大きく下回る値を返す**:
 *
 * ```
 * -- 本物の PostgreSQL 17（container 内。日本語の定型文の繰り返し、4000回）
 * pg_column_size(jsonb)        =     5,369 バイト（圧縮後・格納バイト）
 * octet_length(jsonb::text)    =   456,012 バイト（実テキスト。JSON.parse が見る量）
 * ⟹ 約85倍の過小申告
 *
 * -- 圧縮の効かないランダム文字列（対照）
 * pg_column_size               =    40,016 バイト
 * octet_length(...::text)      =    40,012 バイト
 * ⟹ ほぼ一致（圧縮が効かなければ差は出ない＝原因は圧縮である）
 * ```
 *
 * **alteroid が貯めている本文はいちばん圧縮が効く種類**（約束の台帳の手順・
 * 禁止領域、日誌の同じ文面の繰り返し、マネージャーの報告）である。⟹ **格納
 * バイトだけで判定すると、いちばん危ない表をいちばん小さく報告する**——検知が、
 * 役に立たない方向に嘘をつく。
 *
 * ⟹ **この実装は2つの数を別々の欄として返す**（下の `TableSizeStats` の
 * `storedBytes` / `textBytes`）。**閾値の比較は実テキストバイト
 * （`textBytes`）の側で行う**（`apps/daemon/src/boot-footprint.ts` の
 * `tablesExceedingHeapShare`）——格納バイトを `heap_size_limit` と比べても
 * 意味が無い。
 *
 * ⚠️ **同じ穴が #1284 の `session-store.ts` の `measureSize`
 * （`sum(pg_column_size(entry))` を 512 MiB の予算と比べている）にも在る。**
 * ⛔ **この PR ではそちらを直さない**（範囲外。別 PR の領分）。
 *
 * ## 契約（`session-store.ts` の `measureSize` と同じ形。踏襲している）
 *
 * - **本文（`jsonb` / `text` 列）を Node のメモリへ載せない。** 見るのは
 *   `count(*)` と `sum(pg_column_size(col))` と `sum(octet_length(col::text))`
 *   （と、それぞれの `max`）だけ——**返ってくるのは数値だけ**で、本文そのもの
 *   は SELECT の結果集合に1度も現れない。`octet_length(col::text)` は
 *   PostgreSQL 側では本文を伸長する（下の「なぜコストが要るか」）が、
 *   Node 側が受け取るのはその長さを表す1つの数値だけであり、「本文を Node の
 *   メモリへ載せない」という契約は保たれている。
 * - **測れなかった（クエリが投げた。含む: タイムアウトで打ち切られた）は
 *   `null`。実測して0行／0バイトは `0`。型で区別する**（AGENTS.md 地雷表
 *   「取れない軸に 0 の行を作る」）。集約関数（`sum` / `max`）は対象が0行だと
 *   SQL の `NULL` を返す——それは「測れなかった」ではなく「実測して0（該当する
 *   行が無かった）」なので `0` にする。
 * - **測定は起動を止めない。** 表ごとに独立した `try`/`catch` に包んであり、
 *   1つの表の測定が投げても他の表・呼び出し元へは伝播しない。この
 *   `measureStorageFootprint` 自体も throw しない。
 *
 * ## なぜ `octet_length(col::text)` にコストの上限が要るか
 *
 * `pg_column_size` と違い、`octet_length(col::text)` は本文を実際に展開
 * （伸長・テキスト化）してから長さを測る——**この検知そのものが、避けたい
 * はずの重い読みを引き起こしかねない。** だから `octet_length` を含む問い
 * 合わせは**トランザクション内で `statement_timeout` を設定してから**撃つ
 * （`SET LOCAL` と同じ効果を持つ `set_config(..., true)`。トランザクションが
 * 終われば自動的に既定へ戻るので、この測定が他のクエリへ影響を残さない）。
 * タイムアウトで打ち切られたら、その表は「測れなかった」（`null`）として
 * 続行する——`測定は起動を止めない` という不変条件は保たれる。
 *
 * `STATEMENT_TIMEOUT_MS`（**暫定値。オーナーが決めること**）は表ごとの
 * クエリ1本に許す上限で、5表は並行に撃つので合計の待ち時間はこれを大きく
 * 超えない。
 */

/** `octet_length` を含む問い合わせ1本に許す上限（ミリ秒）。**暫定値。オーナーが決めること。** */
export const STATEMENT_TIMEOUT_MS = 3000;

/** 1つの表（または表の中の1区分）ぶんの実寸。 */
export interface TableSizeStats {
  /** 行数。測れなかったら `null`。実測して0行なら `0`。 */
  rows: number | null;
  /**
   * `sum(pg_column_size(col))`（バイト）。**格納バイト（圧縮後）。**
   * ⚠️ **圧縮が効く本文では、実際のテキストサイズを大きく下回る**（上の
   * ファイル doc の実測）。この値だけで危険度を判断しないこと——比べるなら
   * `textBytes` を使う。測れなかったら `null`。
   */
  storedBytes: number | null;
  /**
   * `sum(octet_length(col::text))`（バイト）。**実テキストバイト——
   * `JSON.parse` / SDK が実際に読み込む量に対応する。** 閾値の比較は
   * こちらで行う（`boot-footprint.ts` の `tablesExceedingHeapShare`）。
   * 測れなかったら（クエリが投げた・`statement_timeout` で打ち切られた）
   * `null`。
   */
  textBytes: number | null;
  /** `max(pg_column_size(col))`（最大1行の格納バイト）。測れなかったら `null`。 */
  maxStoredBytes: number | null;
  /** `max(octet_length(col::text))`（最大1行の実テキストバイト）。測れなかったら `null`。 */
  maxTextBytes: number | null;
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

/** `journal` の窓1つぶん（行数・バイトのみ。`max*` は測っていない）。 */
export interface JournalWindowStats {
  rows: number | null;
  storedBytes: number | null;
  textBytes: number | null;
}

/** `journal`（全体 / 直近3日、窓ごとに独立して測る）。 */
export interface JournalFootprint {
  all: JournalWindowStats;
  /** `at >= now() - interval '3 days'`。 */
  recent3d: JournalWindowStats;
}

/** `archive`（`body` は `text` 列。`pg_column_size` / `octet_length` は text にも使える）。 */
export type ArchiveFootprint = TableSizeStats;

/** 起動時に測る表ぶんの実寸をまとめたもの。 */
export interface StorageFootprint {
  jobs: JobsFootprint;
  commitments: CommitmentsFootprint;
  inboxEvents: InboxEventsFootprint;
  journal: JournalFootprint;
  archive: ArchiveFootprint;
  /** 5表すべての測定に実際に掛かった時間（ミリ秒。並行に撃つので合計ではなく壁時計）。 */
  measurementMs: number;
}

/** 測れなかった（クエリが投げた）ときの `TableSizeStats`。全欄 `null`。 */
const UNMEASURABLE: TableSizeStats = {
  rows: null,
  storedBytes: null,
  textBytes: null,
  maxStoredBytes: null,
  maxTextBytes: null,
};

/** SQL の `NULL`（集約対象が0行）を「実測して0」として数値化する。 */
function zeroIfNull(value: number | string | null): number | null {
  return value === null ? 0 : toNumber(value);
}

/**
 * `statement_timeout` をこのトランザクションだけに掛けて `body` を実行する。
 *
 * `SET LOCAL statement_timeout = …` と同じ効果を `set_config(..., true)`
 * （第3引数 `is_local`）で得る——**バインド変数を使えるのはこちらの形だけ**
 * （`SET` コマンドはプレースホルダを受け付けない）。トランザクションが
 * 終わればこの設定は自動的に戻るので、測定用の接続がプール経由で他の処理へ
 * 使い回されても影響を残さない。
 *
 * **この形は `session-store.ts` の `measureSize` も使う**（あちらも
 * `octet_length(entry::text)` で本文を展開するので、同じ上限が要る）。⟹
 * 上限の値（`STATEMENT_TIMEOUT_MS`）はオーナーが1か所で決められる。
 */
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

/**
 * 起動時の器の実寸を測る（#1283、段2）。**本文は Node のメモリへ載せない。**
 *
 * 5つの表（区分）を独立に測る——1つが投げても（`statement_timeout` で
 * 打ち切られた場合を含め）他は測り続ける（上のファイル doc「測定は起動を
 * 止めない」）。`Promise.all` で束ねているのは並行に撃つためで、失敗の伝播
 * とは無関係——各 `measure*Footprint` は自分の `try`/`catch` の中で必ず
 * 解決し、reject しない（この関数自体も reject しない）。
 *
 * `statementTimeoutMs` は表ごとのクエリ1本に許す上限（既定
 * `STATEMENT_TIMEOUT_MS`）。テストで小さい値へ差し替えられるよう引数にして
 * ある。
 */
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
