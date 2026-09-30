/**
 * オフセット付き ISO 8601 時刻（`isoDateTime`、`z.string().datetime({ offset: true })`）
 * を**実時刻**で比べる（issue #2451）。`Array.prototype.sort` の比較関数としてそのまま
 * 渡せる（昇順。降順にしたいなら引数を入れ替える）。
 *
 * **文字列の `localeCompare` や `<` で比べないこと。** `isoDateTime` はオフセット付きの
 * 任意の表記を許すので、同じ瞬間でも書き方は一意ではない——
 * `'2026-09-27T09:00:00+09:00'`（実時刻 00:00Z）は `'2026-09-27T01:00:00Z'` より前だが、
 * 文字列では後ろに来る。pg は `timestamptz` 列の `asc()` / `desc()` / `min()` で実時刻を
 * 比べるので、fs / インメモリもここで揃える（3実装で同じ並びにする）。
 *
 * **ここが唯一の出所である。** `storage-fs` とインメモリ（`testing.ts`）の許可の記録
 * （`grantedAt`）・台帳（`at` / `closedAt`）・受信箱（`at` と最古の時刻）がこれを呼ぶ。
 * `AuthStore` の `compareCreatedAt`（issue #1676）は同じ式を先に持っていたもので、
 * ここへは寄せていない（`storage-fs/src/auth.ts` / `testing.ts` の同名の関数）。
 *
 * **同着（実時刻が同じ）は 0 を返す。** 2次キーは決めない——pg の側がこれらの一覧に
 * 2次キーを持たないので、ここで足しても3実装は揃わない。
 *
 * 読めない表記（`Date.parse` が `NaN`）は想定しない。呼ぶ側の値はどれもスキーマ
 * （`isoDateTime`）を通っている。
 */
export function compareIsoInstant(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/**
 * 実時刻でいちばん古い時刻を、**渡された表記のまま**返す（空なら `undefined`）。
 * 受信箱の `pending().oldestAt`（pg は `min(at)`）を fs / インメモリで出すためのもの。
 * 同着なら先に現れたほうを返す。
 */
export function earliestIsoInstant(values: Iterable<string>): string | undefined {
  let earliest: string | undefined;
  for (const value of values) {
    if (earliest === undefined || compareIsoInstant(value, earliest) < 0) earliest = value;
  }
  return earliest;
}
