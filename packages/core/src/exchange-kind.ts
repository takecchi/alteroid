/**
 * `type: 'exchange'` の本文の先頭に置く、種類の接頭辞（issue #1332）。
 *
 * ## なぜ在るのか
 *
 * `journal_read` は `types` で絞れるが、絞る先が `exchange` という1種類しか
 * 無い。実際には「人間・マネージャーと交わした生の発言」「あとから人間が
 * 否定しうる自律的な判断」「重複排除・上限による定型のハウスキーピング」
 * 「明示的な失敗」「プロセス跨ぎの継続性（resume・拾い直し）」「消費・枠の
 * 計測値そのもの」という質の違う6種類が、`exchange` という同じ型に無差別に
 * 混ざっている（issue #1332 本文、`clone.ts` の #36 に対応する箇所が典型 ——
 * 「これはクローンの判断ではなくシステムの失敗なので、判断として記録しない」
 * という直前のコメントの直後に `type: 'exchange'` で書いている）。
 *
 * ## なぜ schema ではなく本文の接頭辞なのか
 *
 * `journalEntrySchema`（`schema.ts`）の `exchange` 枝は変えない——過去の
 * 行と新しい行が同じ形のまま混在し続けられることを優先した。**新しい列
 * （`kind` のような構造欄）を足す案は、今回は採らない**（変えるなら
 * schema マイグレーションと過去分の扱いが要り、issue #1332 の射程を超える）。
 * 代わりに、書く側が本文の先頭に固定の接頭辞を置き、読む側が前方一致で
 * 復元する——この形は PR #1362（`inferAppraisedByFromGrounds` / 評定の
 * `grounds` 4定数、`schema.ts`）が先に採っている形に倣った。**実装は
 * 共有しない（独立に持つ）。** 着手時点（この doc を書いた時点）では
 * PR #1362 は `main` 未マージだった——依存すると、あちらがマージされない・
 * 設計が変わる場合にこちらまで巻き込むため、あえて別ファイルへ独立に置いた。
 * **PR #1362 はその後 `main` へ合流した**（`9ba0d43`）。形を
 * `inferAppraisedByFromGrounds` 側（`schema.ts` へ寄せる）に揃える案も
 * あったが、揃えなかった——理由は2つ。(1) あちらは「評定の grounds」という
 * `journalEntrySchema` の構造欄の一部を読む関数で、`schema.ts` に置く必然性が
 * ある。こちらは `type: 'exchange'` の自由文（`text`）だけを見る関数で、
 * schema の構造とは無関係——`schema.ts` へ寄せる理由がそもそも無い。
 * (2) 呼び出し元（`clone.ts` / `manager.ts`）は `schema.ts` を既に import
 * しているので、置き場所を変えても import 元が減るような利得は無い。
 * ⟹ 独立ファイルのまま、パターン（定数 + 前方一致で復元する関数）だけ揃えた。
 *
 * ## 6種類で閉じる（7つ目は作らない）
 *
 * 「判断」でも「障害」でもない「整合性異常の通知」（例: runner の重複検知）
 * のような、7種類目が要りそうに見える行が実際にある。**それでも6種類で
 * 閉じる**——「障害」（明示的な失敗の実況）の中に含めて扱う。種類を割るのは
 * 実際に読み分けの需要が出てからでよく、先に区分けを増やすと「間引きか
 * 判断か」のような既存の迷いと同じ形の迷いをもう1つ増やすだけになる。
 *
 * | kind        | 接頭辞         | 意味                                                             |
 * | ----------- | -------------- | ------------------------------------------------------------------ |
 * | `reply`     | `[応答] `      | 人間・マネージャーと実際に交わした発言そのもの                     |
 * | `decision`  | `[判断] `      | 選択肢から1つを選んだ記録（あとから人間が読んで否定しうるもの）    |
 * | `thinning`  | `[間引き] `    | 合図を減らす・畳む目的の、重複排除・上限到達による定型の運用       |
 * | `failure`   | `[障害] `      | 明示的な失敗（catch節の「〜に失敗した」「〜できなかった」）と、    |
 * |             |                | 整合性異常の通知（7種類目を作らずここへ含める）                    |
 * | `recovery`  | `[復旧] `      | resume・拾い直し等、プロセス跨ぎの継続性の実況。**成功した記録・   |
 * |             |                | 試みた（進行中の）記録が対象。失敗の記録は `failure`。**           |
 * | `gauge`     | `[計器] `      | 消費・枠・カウンタなど計測値そのものの実況（成功/失敗の色がない）  |
 *
 * ## `with: 'human'` には付けない
 *
 * `with` が `'human'`（あるいは分岐の結果 `'human'` に定まる側）の行は、
 * その1欄で「人間との生の往復である」ことが既に構造化されて分かる ——
 * 本文の先頭にもう1つ印を重ねる意味が薄い。**接頭辞の有無で
 * 「これは応答である」を言っているのではなく、「これは応答**ではない**
 * 6種類のどれかである」を言っている**、と読むこと（応答＝`with: 'human'`
 * の行は、この関数の対象から最初から外れている）。
 *
 * 分岐で `with` が `'self'` にも `'human'` にもなりうる箇所（`clone.ts` の
 * `apply`）は、`'self'` 側の分岐にだけ接頭辞を付け、`'human'` 側には付けない
 * ——1つの呼び出しの中に両方の分岐がある形なので、他の箇所と違って
 * 「この行には付ける／付けない」を行単位ではなく分岐単位で決めている。
 *
 * ## 既存の `[${managerId}] ` との重ね順
 *
 * マネージャー越しの行の多くは、本文が `[${managerId}] ...` あるいは
 * `[${event.managerId}] ...` で始まる（人間が読む・grep する慣行であって、
 * 機械的にパースしている読み手は無い——`superseded.ts` の
 * `body.startsWith('[report] ')` は台帳の別の欄（`commitmentFor` が
 * `event.kind` から独立に組む `body`）を見ており、ここで足す接頭辞とは
 * 無関係）。**この接頭辞は managerId の外側に置く**——`[障害] [mgr-x] ...`
 * の順。理由: kind は「この日誌エントリの性質」という、誰が発したかより
 * 一段上の分類であり、`journal_read` で `text` の前方一致・`startsWith`
 * 相当の絞り込みをするとき、kind を最初に固定できたほうが揃う。
 */

/** 人間・マネージャーと実際に交わした発言そのもの。 */
export const EXCHANGE_KIND_REPLY_PREFIX = '[応答] ';
/** 選択肢から1つを選んだ記録（あとから人間が読んで否定しうるもの）。 */
export const EXCHANGE_KIND_DECISION_PREFIX = '[判断] ';
/** 合図を減らす・畳む目的の、重複排除・上限到達による定型の運用ハウスキーピング。 */
export const EXCHANGE_KIND_THINNING_PREFIX = '[間引き] ';
/** 明示的な失敗、および整合性異常の通知（7種類目を作らずここへ含める）。 */
export const EXCHANGE_KIND_FAILURE_PREFIX = '[障害] ';
/** resume・拾い直し等、プロセス跨ぎの継続性の実況。成功・試みた記録が対象。 */
export const EXCHANGE_KIND_RECOVERY_PREFIX = '[復旧] ';
/** 消費・枠・カウンタなど計測値そのものの実況（成功/失敗の色がない）。 */
export const EXCHANGE_KIND_GAUGE_PREFIX = '[計器] ';

/** {@link inferExchangeKindFromText} が返す6値。 */
export type ExchangeKind = 'reply' | 'decision' | 'thinning' | 'failure' | 'recovery' | 'gauge';

/**
 * 6つの接頭辞を、宣言順（`ExchangeKind` の列挙順）と対応付けた表。
 *
 * **配列にしてあるのは、`inferExchangeKindFromText` と
 * `exchange-kind-coverage.test.ts`（静的な網羅性の歯）の両方がここから
 * 同じ順で読むため**——2箇所に同じ6組を書き写すと、足し引きしたときに
 * 片方だけ直る穴が生まれる（AGENTS.md「取れない軸に0の行を作る」と同型の
 * 注意）。
 */
export const EXCHANGE_KIND_PREFIXES: ReadonlyArray<{
  readonly kind: ExchangeKind;
  readonly prefix: string;
}> = [
  { kind: 'reply', prefix: EXCHANGE_KIND_REPLY_PREFIX },
  { kind: 'decision', prefix: EXCHANGE_KIND_DECISION_PREFIX },
  { kind: 'thinning', prefix: EXCHANGE_KIND_THINNING_PREFIX },
  { kind: 'failure', prefix: EXCHANGE_KIND_FAILURE_PREFIX },
  { kind: 'recovery', prefix: EXCHANGE_KIND_RECOVERY_PREFIX },
  { kind: 'gauge', prefix: EXCHANGE_KIND_GAUGE_PREFIX },
];

/**
 * `type: 'exchange'` の `text` から、先頭の接頭辞を見て kind を復元する。
 *
 * **前方一致だけを見る。** 本文の途中に同じ文字列が現れても当たらない
 * ——「先頭に固定の接頭辞を置く」という書く側の約束と対にした、いちばん
 * 単純な判定である。**未知の文面（接頭辞が無い・似て非なる文字列・
 * `with: 'human'` の行）は `undefined`**——「6種類のどれでもない3つ目の
 * 答え」ではなく「この行の kind をこの関数からは判定できない」という意味
 * （AGENTS.md「判定できないという3つ目の状態を持つ」）。呼び出し側はこれを
 * 別に数えること。
 */
export function inferExchangeKindFromText(text: string): ExchangeKind | undefined {
  for (const { kind, prefix } of EXCHANGE_KIND_PREFIXES) {
    if (text.startsWith(prefix)) return kind;
  }
  return undefined;
}
