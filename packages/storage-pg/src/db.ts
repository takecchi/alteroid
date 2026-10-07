import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

// 具体ドライバに固定しない: CI に DB を要求するか、テストを偽物で書くかの二択になるため。
export type Db = PgDatabase<PgQueryResultHKT>;

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// 素通しで返さない: 型情報を保たない経路では bigint が文字列のままになり、`+` が文字列連結になるため。
export function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

// 型を足して呼ぶ: tsconfig の `lib` は ES2023 で `toWellFormed` の型が無いため。
function toWellFormed(value: string): string {
  return (value as string & { toWellFormed(): string }).toWellFormed();
}

// NUL と孤立サロゲートで挿入を落とさない: PostgreSQL の `text` / `jsonb` が拒み、器によって記録が消えるため。
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

// 列の既定の照合順に任せない: PGlite と本番で並びが変わり、fs / インメモリとも食い違うため。
export function byteOrder(column: SQLWrapper): SQL {
  return sql`${column} collate "C"`;
}
