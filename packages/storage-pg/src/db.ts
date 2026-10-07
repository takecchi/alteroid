import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * ドライバを問わない drizzle のハンドル。
 *
 * 本番は node-postgres、テストは PGlite（インプロセスの実 PostgreSQL）で同じ
 * コードを通す。ここを具体ドライバに固定すると、CI に DB を要求するか、テストを
 * 偽物で書くかの二択になる — どちらもストアの受け入れ確認にならない。
 */
export type Db = PgDatabase<PgQueryResultHKT>;

/** ミリ秒精度の ISO 8601（zod の `datetime({ offset: true })` が通る形）。 */
export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * bigint 列を確実に number へ直す。
 *
 * `bigint(..., { mode: 'number' })` は drizzle の `mapFromDriverValue` が変換する
 * が、それは列の型情報を保ったクエリ経路（`select()` / `returning()`）を通した
 * ときだけである。**素通しで返すと文字列のままになりうる** — そのまま
 * `sumUsageRows` に渡すと `+` が数値の足し算ではなく文字列連結になる
 * （`'10' + '20'` は `'1020'`）。読み出しの出口をここに揃えて必ず通す。
 */
export function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * `String.prototype.toWellFormed`（ES2024、Node 20+）。tsconfig の `lib` は ES2023 なので
 * 型が無く、ここで最小の型だけを足して呼ぶ。
 */
function toWellFormed(value: string): string {
  return (value as string & { toWellFormed(): string }).toWellFormed();
}

/**
 * NUL 文字（`\u0000`）を落とし、孤立サロゲートを U+FFFD に置き換える。
 *
 * PostgreSQL の `text` と `jsonb` は NUL を含む文字列を**受け付けない**。
 * マネージャーと作業者の全ツール実行を日誌に落とす以上、バイナリ由来の NUL が
 * 混ざる経路は現実にある。そこで挿入が落ちると、fs なら残る記録が pg では
 * 静かに消える — 「聞かずに実行した判断は必ず日誌に残る」（PRD「権限境界」）が
 * 器によって崩れる。**器の都合で記録を失うくらいなら、1文字を落として残す。**
 *
 * **孤立サロゲート**（例 `'abc\ud83d'`）も同じ形の穴である。JS の文字列には
 * `JSON.parse('"\\ud83d"')` や UTF-16 の途中で切った文字列として普通に入り、fs のストアは
 * そのまま残せる。node-postgres は `text` 列では U+FFFD へ化けて通すが、`jsonb` は
 * `JSON.stringify` が出すエスケープ `\ud83d` を PostgreSQL が `22P02` で拒む。受信箱の行や
 * 台帳の依頼が書けず、器によって記録が消える。方針は NUL と同じで、1文字を
 * U+FFFD に変えて記録を残す（`toWellFormed()`。正しいサロゲート対は変わらない）。
 * 文字列の値もオブジェクトのキーも通す。関数名は呼び出しが多いので NUL だけの名のまま。
 */
export function stripNulls<T>(value: T): T {
  if (typeof value === 'string') {
    const noNul = value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
    return toWellFormed(noNul) as T;
  }
  if (Array.isArray(value)) return value.map((item) => stripNulls(item)) as T;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      mapped[stripNulls(key)] = stripNulls(source[key]);
    }
    return mapped as T;
  }
  return value;
}

/**
 * 並びのキーを**照合順 C（バイト順）で**比べる式（`auth.ts` の `byteOrder` と
 * 同じ考え方）。列の既定の照合順に任せると、PGlite（C）と本番（`en_US.UTF-8` など）で
 * `_` `-` `.` や大文字小文字の前後が変わり、fs / インメモリ（`compareCodeUnits`）とも
 * 食い違う。`ORDER BY` の式に付けるだけなのでスキーマは変えない。
 */
export function byteOrder(column: SQLWrapper): SQL {
  return sql`${column} collate "C"`;
}
