/**
 * ストアの入口で、NUL（`\u0000`）の扱いを3実装（fs・pg・インメモリ）で揃える
 * ための共通部品（issue #2927。先例は #2233 の `archive-session-id.ts`）。
 *
 * ## 決め（teto の判断、2026-10-05）
 *
 * - **鍵（name・id・参照キー）と、環境変数になる値（credentials の value・
 *   profile の script）に NUL があれば、入口で {@link NulNotAllowedError} を
 *   投げて断る。** 鍵に NUL が混ざると、pg だけ落として除くと fs / インメモリと
 *   同じ文字列が別の行を指す。環境変数の値に NUL は入れられない（`execve` が
 *   途中で切る）ので、落として残すと別の値になる。
 * - **それ以外の本文は、fs も含めて NUL を落として残す**（{@link stripNul}）。
 *   pg の `stripNulls`（`storage-pg/src/db.ts`）の「器の都合で記録を失うくらいなら、
 *   1文字を落として残す」に揃える。
 *
 * **例外の文に値を載せない。** どこから来た値か分からない（資格かもしれない）ので、
 * 何が入っているかをログへ流さない。載せるのは「どの欄か」だけ。型で見分けること
 * （文言で見分けない）。
 */
export class NulNotAllowedError extends Error {
  /** どの欄か（`credential.name` など。値ではない）。 */
  readonly field: string;

  constructor(field: string) {
    super(`${field} に NUL（\\u0000）が含まれているので、受け付けない`);
    this.name = 'NulNotAllowedError';
    this.field = field;
  }
}

/** `value` に NUL が含まれるなら `NulNotAllowedError(field)` を投げる。 */
export function assertNoNul(field: string, value: string): void {
  if (value.includes('\u0000')) throw new NulNotAllowedError(field);
}

/** 本文から NUL を落とす（無ければ同じ文字列をそのまま返す）。 */
export function stripNul(value: string): string {
  return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
}
