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
 * NUL 文字（`\u0000`）を落とす。
 *
 * PostgreSQL の `text` と `jsonb` は NUL を含む文字列を**受け付けない**。
 * マネージャーと作業者の全ツール実行を日誌に落とす以上、バイナリ由来の NUL が
 * 混ざる経路は現実にある。そこで挿入が落ちると、fs なら残る記録が pg では
 * 静かに消える — 「聞かずに実行した判断は必ず日誌に残る」（PRD「権限境界」）が
 * 器によって崩れる。**器の都合で記録を失うくらいなら、1文字を落として残す。**
 */
export function stripNulls<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes('\u0000') ? value.replaceAll('\u0000', '') : value) as T;
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
