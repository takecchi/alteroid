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
