/**
 * ストアの入口で、NUL（`\u0000`）の扱いを3実装（fs・pg・インメモリ）で揃えるための共通部品。
 *
 * - 鍵（name・id・参照キー）と環境変数になる値に NUL があれば断る: 鍵は pg だけ落とすと
 *   fs / インメモリと同じ文字列が別の行を指し、環境変数の値は `execve` が途中で切るので、
 *   落として残すと別の値になる。
 * - 鍵で引く読むだけの口は断らず「無い」と同じ結果を返す: NUL の鍵の行は書き込みで断るので
 *   存在しえず、pg は DB が NUL 入り text をエラーにするので入口で短絡する。
 *   `UsageStore.aggregate()` の絞り込みだけは、書き込みが落として残すので落としてから引く。
 * - それ以外の本文は NUL を落として残す: pg の `stripNulls` と同じく、器の都合で記録を失わない。
 * - 記録を失うほうが害が大きい台帳の欄は、外から来る鍵でも断らず落として残す
 *   （`UsageStore` の `managerId`・`model`・`tokenId`、`CommitmentStore` の `source`、
 *   `JobStore` の参照キー・印と承認待ちの `questions` / `selections` の文字列）。
 *   行を指す鍵（`id`）は断る。部品は `usage-input.ts`・`job-input.ts`。
 *
 * 例外の文に値を載せない: 資格かもしれず、載せるのは「どの欄か」だけ。型で見分け、文言で見分けない。
 */
export class NulNotAllowedError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`${field} に NUL（\\u0000）が含まれているので、受け付けない`);
    this.name = 'NulNotAllowedError';
    this.field = field;
  }
}

export function assertNoNul(field: string, value: string): void {
  if (value.includes('\u0000')) throw new NulNotAllowedError(field);
}

export function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

export function stripNul(value: string): string {
  return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
}

export function stripNulWellFormed(value: string): string {
  // `toWellFormed`（ES2024）は tsconfig の `lib`（ES2023）に型が無いので、最小の型だけ足して呼ぶ。
  return (stripNul(value) as string & { toWellFormed(): string }).toWellFormed();
}

/** 鍵には使わない（鍵は {@link assertNoNul} で断る）。 */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === 'string') return stripNul(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripNulDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    for (const key of Object.keys(source)) mapped[stripNul(key)] = stripNulDeep(source[key]);
    return mapped as T;
  }
  return value;
}
