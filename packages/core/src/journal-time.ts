/**
 * `journal_read` / `conversation_read`（クローンの道具）と `GET /journal`
 * （HTTP）の `since` / `until` を正規化する、唯一の共通の口（issue #1515）。
 *
 * ## 何が壊れていたか
 *
 * `since` / `until` は `z.string()` のまま正規化されずに `JournalQuery` へ渡って
 * いた。ストアごとの扱いが違う：
 *
 * - **pg**（`packages/storage-pg/src/journal.ts`）: `gte(journal.at, new
 *   Date(query.since))` / `lte(...)`。**時刻として**比べる
 * - **fs**（`packages/storage-fs/src/journal.ts`）と**インメモリ**
 *   （`packages/core/src/testing.ts`）: `entry.at < query.since` /
 *   `entry.at > query.until` という**文字列比較**。fs はさらに
 *   `query.since?.slice(0, 10)` で日付ファイルの絞り込みにも使う
 *
 * `entry.at` は常に `new Date().toISOString()` の固定形式（UTC・ミリ秒3桁・
 * `Z` 終端）だが、呼び出し側が渡す `since` / `until` にその保証は無い。
 * 秒を省いた形（`2026-09-12T20:21Z`）や `+09:00` のようなオフセット付きの
 * 文字列が来ると、辞書順と時刻の前後関係が食い違う——
 * `'2026-09-12T20:21Z' > '2026-09-12T20:21:05.123Z'`（辞書順では後ろ）なのに、
 * 時刻としては前である。⟹ pg と、fs・インメモリで答えが割れる。
 *
 * ## 直し方
 *
 * ストア側（fs・インメモリ）を時刻比較へ直すのではなく、**入口の正規化**を
 * 主にした。理由：
 *
 * - **直す先が1つで済む。** ストア実装は3つ（pg / fs / インメモリ）だが、
 *   `JournalQuery` を組み立てる入口（このファイルを呼ぶ箇所）に閉じ込められる
 * - pg は既に時刻で比べているので、そちらを直す理由が無い。「3実装の比べ方を
 *   統一する」ことそのものは目的ではなく、目的は「正規化されていない
 *   since/until が渡ると3実装の答えが割れる」ことを塞ぐことである
 * - 正規化後（`toISOString()`）は `entry.at` と同じ固定形式になるので、
 *   fs・インメモリの文字列比較のコードは1行も変えなくても、時刻比較と
 *   同じ答えになる
 * - fs は日付ファイルの絞り込みにも `since` / `until` を使っている
 *   （`FsJournalStore.list` の `sinceDay` / `untilDay` — `slice(0, 10)`）。
 *   ここも UTC 固定形式の文字列を渡せば、オフセット付きの値で日付を
 *   取り違える穴（issue #1515 の指摘のひとつ）が一緒に塞がる
 *
 * **⚠️ ストア側（fs・インメモリ）に「防御として `Date.parse` で比べ直す」処理は
 * 足していない。** 入口をここ1本に絞れば3実装の答えは揃うし、ストア側にも
 * 同じ判定を足すと「本当に効いているのはどちらか」が歯からは見えなくなる
 * ——同じ仕事を2箇所に書いて、片方だけ直された回に気づけなくなる
 * （`JournalQuery` の他の項目が「契約の正本は1か所に置く」形を繰り返し
 * 選んでいるのと同じ理由。`with` の doc の「組み立てるのは
 * `readConversationWindow` 1か所だけにすること」を見よ）。
 *
 * ## 使う場所（3箇所）
 *
 * - `journal_read`（クローンの道具。`tools.ts`）
 * - `conversation_read`（クローンの道具。`tools.ts`）—— `since` / `until` は
 *   `readConversationWindow`（`conversation.ts`）を経由して同じ `JournalQuery`
 *   へ渡るので、同じ穴を持つ
 * - `GET /journal`（HTTP。`apps/daemon/src/app.ts` の `journalQuery` ハンドラ）
 *
 * **`GET /conversations` / `GET /conversations/:id` は対象外。** 現状
 * `since` / `until` を受け付けていない（`conversationsQuery` / `conversationQuery`
 * の doc）——受け付けていない口を正規化する理由が無い。
 *
 * ## なぜ zod の `.refine()`/`.transform()` ではなくここへ関数を置くか
 *
 * `journal_read` / `conversation_read` の入力検証は MCP SDK 側（`McpServer`）が
 * 行い、**検証に落ちるとハンドラは一度も呼ばれない**（`tools.ts` 冒頭の
 * `MISSING_ARG_HINT` の doc）。それ自体は問題ないが、**この repo のテストの
 * 作法（`journal-read.test.ts` 等）はハンドラを直接呼ぶ**ため、schema 側だけに
 * 検証を置くと、そのテストからは検証を素通りしてしまう。**`commitment_close_bulk`
 * の `until`（`tools.ts`。`z.string().datetime({ offset: true })` を手書きで検査し、
 * 読めなければ `text(...)` で断る）と同じ作法に揃え、ハンドラの中で検証・正規化
 * する。** `GET /journal` は逆に、`afterAt` の検証（同じファイルの
 * `if (afterId !== undefined && afterAt !== undefined && Number.isNaN(Date.parse(afterAt)))`）
 * も同じくハンドラの中の手書き検査であり、ここへ揃える。
 */

/**
 * 受け付ける形の ISO 風パターン（#3287）。年・月・日を取り出すために捕捉する。
 *
 * - 日付 `YYYY-MM-DD`
 * - 日時 `YYYY-MM-DDTHH:MM` / `:SS` / `.sss`（小数秒は1〜9桁）。区切りは `T` か空白1つ
 * - 時差つき日時 末尾に `Z` か `±HH:MM`（`±HHMM` は断る）
 *
 * 量指定子は入れ子にせず線形。
 */
const JOURNAL_TIME_BOUNDARY_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * `value` が日時として読めるか。**3段で見る**（#3287）：
 *
 * 1. ISO 風の形に合う（`JOURNAL_TIME_BOUNDARY_PATTERN`）
 * 2. `Date.parse` が `NaN` を返さない（時・分の範囲外などを落とす）
 * 3. 日付が実在する——年月日を取り出し、`Date` に戻したときに同じ年月日に
 *    なること（`2026-02-31` は `Date.parse` が 3/3 へずらして読むので、
 *    2 だけでは通ってしまう）
 *
 * ## 緩さは意図だった——が、厳しくした（経緯）
 *
 * この関数は #1515 の時点では、`Date.parse` が読める形をすべて許す緩さを
 * **意図して**選んでいた（秒の省略・オフセット付き・スペース区切りなどを
 * `isoDateTime` より緩く通すため）。しかし `Date.parse` の読みは V8 の
 * 慣用の読みで、`'foo 1'` を 2000 年の12月、`'1'` / `'12'` を年月として読み、
 * `2026-02-31` を 3/3 へずらす。**判定できない入力を、黙って別の窓へ倒していた**
 * （#3287）。
 *
 * 2026-10-06 に人間が「厳しくする」と決めた（#3287 の案 A）。緩さを残して
 * 読んだ結果を応答に出す案 C や、存在しない日付だけを断る案 B は採らなかった。
 * 形の線は、いま実際に使われている形から引いた：デーモン・CLI・Web が送るのは
 * `entry.at`（`toISOString()` の `…Z`）だけで、既存のテストは時差なしの日時
 * （`2026-09-25T19:00`）を通すと固定している。空白区切りは、以前の doc が
 * 許すと書いていて、`T` の形と読みが同じ（地方時刻）なので残した。
 * `YYYY/MM/DD`・`Sep 25 2026`・`±HHMM` のような他の形は断る。
 *
 * 時差の無い日時（日付だけの形も含む）は `Date.parse` の読みに従う——日付だけは UTC、
 * 時差なしの日時はサーバーの地方時刻。時差が要る一括操作の口は
 * `isOffsetQualifiedTimeBoundary` で別に締めている。
 */
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

// `YYYY-MM-DDThh:mm[:ss[.fff]]` + (`Z` | `±hh:mm`)。量指定子は入れ子にせず線形。
const OFFSET_QUALIFIED_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `value` が**時差（`Z` か `±hh:mm`）の付いた** ISO 8601 の日時か。
 * **元に戻せない一括操作**（`commitment_close_many` の `until`・`inbox_remove_many` の
 * `before`）の門に使う（#2462）。`isReadableJournalTimeBoundary` は時差の無い
 * `2026-09-25T19:00` も通し（`2026/09/25` / `Sep 25 2026` は #3287 から断る）、**サーバーの地方時刻として読む**ため、
 * 境界が時差ぶんずれたまま消す・閉じる対象が決まってしまう。
 *
 * 形は `T` 区切りのみ（空白区切りは断る）、時差は `Z` か `±hh:mm`（`±hhmm` は断る）。
 * 秒は省略でき（#1515）、小数秒も通す。読むだけの `journal_read` は変えない。
 */
export function isOffsetQualifiedTimeBoundary(value: string): boolean {
  return OFFSET_QUALIFIED_TIME_PATTERN.test(value) && isReadableJournalTimeBoundary(value);
}

/** 時差の無い境界を一括操作の口が断るときの共通の言い方。 */
export function describeOffsetRequiredTimeBoundary(
  field: string,
  value: string,
  example: string,
): string {
  return (
    `${field} に渡された「${value}」は ISO8601 として読めない、または時差が無い` +
    `（時差 Z か +09:00 を必ず書くこと。例 ${example} / 2026-09-11T19:00+09:00）。`
  );
}

/**
 * `since` / `until` を正規化する。**読めなければ `null`。** 読めれば
 * `toISOString()`（UTC・ミリ秒3桁・`Z` 終端——`entry.at` と同じ固定形式）へ
 * 正規化して返す。
 */
export function normalizeJournalTimeBoundary(value: string): string | null {
  if (!isReadableJournalTimeBoundary(value)) return null;
  return new Date(value).toISOString();
}

/** 読めない `since`/`until` を断るときの共通の言い方。呼び出し口ごとに文言が割れないようにする。 */
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
