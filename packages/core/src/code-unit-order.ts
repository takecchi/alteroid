/**
 * 文字列をコード単位（UTF-16）の順で比べる。`localeCompare` と違い、実行環境の
 * ロケールにも ICU の版にも依らない。BMP の範囲では UTF-8 のバイト順（＝
 * PostgreSQL の `collate "C"`）と同じ並びになる。
 *
 * **一覧の並びを決めるキーの比較は、これか `collate "C"` を使うこと**（#2913。
 * 既定の照合順や `localeCompare` では、`_` `-` `.` の前後・大文字小文字の順が
 * 器と環境で変わる）。
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
