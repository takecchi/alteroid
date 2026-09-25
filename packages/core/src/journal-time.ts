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
 * `value` が日時として読めるか。**`Date.parse` が `NaN` を返さないことだけを
 * 見る**——`isoDateTime`（`z.string().datetime({ offset: true })`）より緩い。
 * 秒の省略・オフセット付き・スペース区切りなど、`Date.parse` が読める形は
 * すべて許す（`journal_read` の `since`/`until` の説明文が例示する
 * `2026-08-15T09:00:00Z` はもちろん、issue #1515 が挙げた
 * `2026-09-12T20:21Z` / `+09:00` も読める）。
 */
export function isReadableJournalTimeBoundary(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
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
  field: 'since' | 'until',
  value: string,
): string {
  return (
    `${field} に渡された「${value}」は日時として読めない` +
    '（ISO 8601 で指定する。例 2026-08-15T09:00:00Z）。'
  );
}
