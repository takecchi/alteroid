import { createHash } from 'node:crypto';

import type { ArchiveContinuityTally } from './store.js';

/**
 * 同じ `sessionId` の直前の退避との連続性（#698）。
 *
 * Issue #698 は当初「新しい退避は古い退避を丸ごと前方一致で含む」という前提の
 * もとで、古い写しを畳んで O(N²) を O(N) にする計画だった。**その前提を本番の
 * `archive` テーブルで測り直したら、9ペア中4ペアでしか成り立っていなかった。**
 * ⟹ このモジュールは畳まない——**「畳んでよいかどうかを、積む瞬間に判定して
 * 記録する門」だけ**を作る。判定を本番で貯めたうえで、次の PR で初めて畳む。
 *
 * - `'first'` — この `sessionId` の最初の退避。比べる相手が無い。
 * - `'continues'` — 直前の退避の全文を、新しい本文が先頭から含む（前方一致）。
 * - `'diverged'` — 前方一致しない。**縮んだ場合も、伸びたが前方一致しない
 *   場合も、どちらもここに落ちる**——「縮んだから diverged」ではなく
 *   「前方一致しないから diverged」である。
 * - `'unknown'` — 直前の退避が指紋（`bodyChars` / `bodyMd5`）を持たない
 *   （この機能より前に積まれた行、あるいは指紋の記録自体に失敗した行）。
 *   前方一致するかどうかを確かめる材料が無いので、`'continues'` にも
 *   `'diverged'` にも倒さない。
 *
 * ## この設計が寄りかかっているもの
 *
 * **この設計は「新しい退避は古い退避を先頭に含む」という、alteroid の外の
 * 世界（Claude Agent SDK の生ログの書き方）の性質に寄りかかっている。** SDK が
 * 書き方を変えれば、この前提は黙って崩れる。**崩れたときは畳まず、`'diverged'`
 * として記録する**——`classifyArchiveContinuity` はどんな入力に対しても
 * 「前方一致するか」だけを機械的に見るので、前提が崩れた世界でも嘘の
 * `'continues'` を返すことはない（前方一致が実際に崩れていれば `'diverged'`
 * になるだけである）。
 */
export type ArchiveContinuity = 'first' | 'continues' | 'diverged' | 'unknown';

/**
 * 本文の指紋（#698）。`classifyArchiveContinuity` が前方一致を確かめるための
 * 最小限の材料——本文そのものは持ち回らない（100MB 級の行がある `archive` で、
 * 判定のためだけに本文を読み直すと Issue #698 の動機そのものを壊す）。
 */
export interface ArchiveBodyFingerprint {
  /**
   * 本文の長さ。**JS の文字列 `length`（UTF-16 コード単位）であって、
   * PostgreSQL の `length()`（コードポイント数）ではない。** サロゲートペア
   * （絵文字等）を含む本文では両者が食い違う——`fingerprintArchiveBody` と
   * `classifyArchiveContinuity` の `body.slice(0, previous.bodyChars)` は
   * どちらも同じ JS の数え方（UTF-16 コード単位）で揃えてあるので、この
   * モジュールの内部で不整合は起きない。**pg 側で `length(body)` のような
   * SQL 関数の値と混ぜないこと。**
   */
  readonly bodyChars: number;
  readonly bodyMd5: string;
}

/** `body` の指紋を取る。md5 は照合専用（暗号用途ではない）。 */
export function fingerprintArchiveBody(body: string): ArchiveBodyFingerprint {
  return { bodyChars: body.length, bodyMd5: md5Hex(body) };
}

/**
 * 直前の退避（`previous`）と新しい本文（`body`）の連続性を判定する（#698）。
 *
 * 判定規則（この4つ以外の状態を作らない）:
 *
 * 1. `previous` が `null`/`undefined` ⟹ `'first'`（`comparedTo` 無し）
 * 2. `previous.bodyChars` か `previous.bodyMd5` のどちらかが欠けている ⟹
 *    `'unknown'`（`comparedTo = previous.id`）
 * 3. `md5(body.slice(0, previous.bodyChars))` が `previous.bodyMd5` と一致
 *    ⟹ `'continues'`
 * 4. 一致しない ⟹ `'diverged'`
 *
 * ## 🔴 絶対にやってはいけないこと
 *
 * - **⛔ 長さの大小で判定しない。** 本番で「1% 伸びているのに前方一致が偽」
 *   という行が実測されている。⟹ **単調性（伸びた／縮んだ）は連続性の証拠にも
 *   反証にもならない。** この関数は `body.length` と `previous.bodyChars` の
 *   大小を一度も比較しない——比較するのは md5 だけである。
 * - **⛔ `'unknown'` を `'continues'` に倒さない。** 既存の 5.4GB の行には
 *   指紋が無い。**倒すと、確かめずに畳んでよいと言うことになる**——この PR は
 *   「畳んでよいかどうかを確かめずに済ませる」ことこそを止めるためにある。
 * - **⛔ `previous.bodyChars > body.length` を特別扱いしない。** その場合
 *   `body.slice(0, previous.bodyChars)` は `body` 自身より短い文字列には
 *   ならない（`slice` は範囲外の終端を単に丸めるだけ）が、結果として
 *   `body` 全体になり、`previous.bodyMd5`（縮む前の長い本文の md5）とは
 *   まず一致しない——**自然に `'diverged'` になる。それが正しい**
 *   （短いものが長いものを含むことはないので、縮んだ行が前方一致するはずが
 *   ない）。この関数の側で `bodyChars` の大小を見て早期に分岐したりしない。
 */
export function classifyArchiveContinuity(
  previous:
    | { readonly id: string; readonly bodyChars?: number | null; readonly bodyMd5?: string | null }
    | null
    | undefined,
  body: string,
): { readonly continuity: ArchiveContinuity; readonly comparedTo?: string } {
  if (previous === null || previous === undefined) {
    return { continuity: 'first' };
  }
  if (
    previous.bodyChars === null ||
    previous.bodyChars === undefined ||
    previous.bodyMd5 === null ||
    previous.bodyMd5 === undefined
  ) {
    return { continuity: 'unknown', comparedTo: previous.id };
  }
  const prefixMd5 = md5Hex(body.slice(0, previous.bodyChars));
  return prefixMd5 === previous.bodyMd5
    ? { continuity: 'continues', comparedTo: previous.id }
    : { continuity: 'diverged', comparedTo: previous.id };
}

function md5Hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * `archive()` の呼び手が、`continuity` を日誌へ記録するかどうかと、記録する
 * ならその文面を決める（#698）。
 *
 * **`'first'` / `'continues'` は記録しない（`null` を返す）。** compaction /
 * `stop()` のたびに `'continues'` を1行ずつ日誌へ積むと、ノイズにしかならない
 * ——母数（`'continues'` を含めた全体）は `archive` テーブル / 実装の
 * `continuity` 列を `group by` すれば、本文に一切触れずに数えられる
 * （`ArchiveEntry.continuity` を持つ行を集計するだけでよい）。日誌に残す
 * 理由が無い。
 *
 * **呼び手ごとに文言を変える。** `archive()` の呼び出し元は3つ
 * （`clone.ts` の `#onPreCompact` / `#salvageTranscript`、`manager.ts` の
 * `case 'archive'`）あり、同じ形の日誌行を残すと「どちらが書いたか」を
 * 区別できなくなる。`caller` にはその呼び手を名乗る短い文字列
 * （例: `'PreCompact の退避'`）を渡すこと——3つの呼び出し元が異なる文字列を
 * 渡すことで、日誌の文言そのものが区別できる形になる。
 *
 * **本文そのもの・断片は乗せない。** 載せるのは呼び手の名前 / `sessionId` /
 * `continuity` / `comparedTo` / 本文の長さだけ。
 */
export function describeArchiveContinuityForJournal(params: {
  readonly caller: string;
  readonly sessionId: string;
  readonly continuity: ArchiveContinuity;
  readonly comparedTo?: string;
  readonly bodyChars: number;
}): string | null {
  if (params.continuity !== 'diverged' && params.continuity !== 'unknown') return null;
  const comparedToPart = params.comparedTo === undefined ? '' : ` comparedTo=${params.comparedTo}`;
  return (
    `[${params.caller}] continuity=${params.continuity} sessionId=${params.sessionId} ` +
    `bodyChars=${params.bodyChars}${comparedToPart}`
  );
}

/**
 * `ArchiveEntry.continuity` の列（1セッション分）を `ArchiveSessionSummary.continuity`
 * の内訳へ積み上げる（#698 続き）。`storage-fs` とインメモリ実装
 * （`testing.ts`）が共有する——どちらも `list()` 相当の行を JS 側へ引き上げて
 * から集計するので、同じ数え方を1箇所に置く。
 *
 * pg 実装（`storage-pg/src/archive.ts`）はこの関数を使わない。SQL の
 * `count(*) filter (where …)` で同じ内訳を1問い合わせの中で数えており、
 * `body` はおろか行そのものを JS 側へ引き上げないため（`list()` / `sessions()`
 * の doc「`body` に触れない」を集計でも保つ）。
 *
 * **`undefined` は `absent` に数える。** `ArchiveEntry.continuity` が無いのは
 * 「その行が門（#873）より前に積まれた」ことを意味し、`'unknown'`（門は
 * 通ったが直前の行の指紋が無かった）とは別の状態——畳まない理由は
 * `ArchiveContinuityTally` の doc（`store.ts`）を見よ。この関数は
 * その区別を保ったまま数えるだけで、判定はしない（判定は
 * `classifyArchiveContinuity` の役目である）。
 */
export function tallyArchiveContinuity(
  continuities: ReadonlyArray<ArchiveContinuity | undefined>,
): ArchiveContinuityTally {
  const tally = { first: 0, continues: 0, diverged: 0, unknown: 0, absent: 0 };
  for (const continuity of continuities) {
    if (continuity === undefined) {
      tally.absent += 1;
      continue;
    }
    tally[continuity] += 1;
  }
  return tally;
}
