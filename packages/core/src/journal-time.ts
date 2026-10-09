// `since` / `until` は入口のここ1本で正規化する。ストア側（fs・インメモリ）に「防御として `Date.parse` で比べ直す」処理は足さない: 同じ判定を2箇所に置くと、本当に効いているのがどちらかが歯から見えなくなる。
// 正規化後は `entry.at` と同じ固定形式（UTC・ミリ秒3桁・`Z` 終端）になるので、fs・インメモリの文字列比較と日付ファイルの絞り込み（`slice(0, 10)`）も pg の時刻比較と同じ答えになる。
// 検証は zod の `.refine()` / `.transform()` ではなくハンドラの中で行う: このリポジトリのテストはハンドラを直接呼ぶので、schema 側だけに置くと検証を素通りする。

// 量指定子は入れ子にせず線形。
const JOURNAL_TIME_BOUNDARY_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

// `Date.parse` だけで判定しない: V8 の慣用の読みが `'foo 1'` を2000年12月、`'1'` を年月として読み、`2026-02-31` を 3/3 へずらすため。形・`Date.parse`・日付の実在の3段で見る。
// 時差の無い日時は `Date.parse` の読みに従う（日付だけは UTC、時差なしの日時はサーバーの地方時刻）。時差が要る口は `isOffsetQualifiedTimeBoundary` で別に締める。
export function isReadableJournalTimeBoundary(value: string): boolean {
  const match = JOURNAL_TIME_BOUNDARY_PATTERN.exec(value);
  if (match === null) return false;
  if (Number.isNaN(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // `Date.UTC` は 0〜99 年を 1900 年代へ読み替えるので、`setUTCFullYear` で組む。
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

// 量指定子は入れ子にせず線形。
const OFFSET_QUALIFIED_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// 元に戻せない一括操作（`commitment_close_many` の `until`・`inbox_remove_many` の `before`）の門: 時差が無いとサーバーの地方時刻として読まれ、境界が時差ぶんずれたまま消す・閉じる対象が決まる。
export function isOffsetQualifiedTimeBoundary(value: string): boolean {
  return OFFSET_QUALIFIED_TIME_PATTERN.test(value) && isReadableJournalTimeBoundary(value);
}

export function describeOffsetRequiredTimeBoundary(
  field: string,
  value: string,
  example: string,
): string {
  return (
    `${field} に渡された「${value}」は日時として読めない、または時差が無い` +
    `（ISO 8601 で指定する。時差 Z か +09:00 を必ず書くこと。受け付ける形の例 ${example} / ` +
    '2026-09-11T19:00+09:00。実在しない日付も断る）。'
  );
}

export function normalizeJournalTimeBoundary(value: string): string | null {
  if (!isReadableJournalTimeBoundary(value)) return null;
  return new Date(value).toISOString();
}

export function describeUnreadableJournalTimeBoundary(
  field: 'since' | 'until' | 'before',
  value: string,
): string {
  return (
    `${field} に渡された「${value}」は日時として読めない` +
    '（ISO 8601 で指定する。受け付ける形の例 2026-10-06 / 2026-10-06T09:00 / ' +
    '2026-10-06T09:00:00+09:00 / 2026-10-06T09:00:00Z。実在しない日付も断る）。'
  );
}
