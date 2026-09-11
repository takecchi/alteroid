/**
 * PR / Issue の本文に置く「出所の刻印」の名前（Issue #850）。
 *
 * ## 何を埋めるための刻印か
 *
 * `main` に入ったコミットは、squash マージの subject が `… (#N)` で終わるので
 * PR 番号までは機械的に引ける。**そこから先（どの委譲が作った PR か）が
 * 引けない** — git の author も GitHub の actor も、クローン・マネージャー・
 * 人間の3層すべてで人間の名前になる（`AGENTS.md`「リポジトリの約束」の
 * 「git / GitHub の actor から層を推定しないこと」）。層は git の外にしか
 * 残らないので、**PR / Issue の本文そのものに機械可読な1行を置く**ことにした。
 *
 * ## なぜ台帳（`usage.ts`）の actor の語彙をそのまま使うのか
 *
 * 刻印の値と台帳の `managerId` / `CLONE_ACTOR_ID` が別々の語彙を持つと、
 * 「この PR を作ったのは `mgr-xxxx` だ」と刻んだ値が台帳のどの行とも
 * 突き合わせられない、という状態を自分で作ることになる。**書き手（この刻印）と
 * 読み手（台帳）が同じ出所の値を使う**ことで、`manager_report` / `manager_list`
 * が持つ id をそのまま刻印の値として使い、後から突き合わせられるようにする。
 * `CLONE_ACTOR_ID` を新しく `'clone'` と書き写さずここから import するのは、
 * その突き合わせが2箇所の文字列リテラルの一致に依存する状態を作らないためである
 * （どちらか一方だけを直せば静かにずれる）。
 *
 * ## なぜ `human` という値が要るのか
 *
 * 「出所が分からない」と「出所が無い（人間が直接作った）」は別の状態である。
 * オーナー自身が PR を出すことは実際に在り（Issue #850 の PR #834 がそれ）、
 * **刻印が無いことを「人間のもの」と読み替えると、クローンが自分の成果を
 * 数え損ねる**（無印を human の意味で使うと、クローン/マネージャーが刻印を
 * 忘れた回と、人間が本当に直接作った回が区別できなくなる）。だから「無印」
 * とは別に、人間が直接作ったことを**積極的に名乗る**値を持つ。
 */
export const ORIGIN_MARKER_NAME = 'alteroid-origin';

/**
 * 人間が直接作ったことを積極的に名乗る値。**「刻印が無い」の代わりではない。**
 * 上の doc の「なぜ `human` という値が要るのか」を見よ。
 */
export const ORIGIN_HUMAN = 'human';

/**
 * PR / Issue の本文に置く刻印の1行を作る。
 *
 * `origin` には `managerId`（`mgr-` 接頭辞）・`CLONE_ACTOR_ID`（`usage.ts`）・
 * `ORIGIN_HUMAN` のいずれかを渡す。**この関数だけが刻印の文字列を組み立てる** —
 * 書く側（`prompt.ts`）と読む側（`scripts/check-pr-origin-core.mjs`）が別々に
 * 同じ形の文字列を手で書くと、どちらか一方が変わったときに静かにずれる。
 */
export function formatOriginMarker(origin: string): string {
  return `<!-- ${ORIGIN_MARKER_NAME}: ${origin} -->`;
}

// **`CLONE_ACTOR_ID` はここでは定義も再輸出もしない。** 呼び出し側
// （`prompt.ts`）は `usage.ts` から直接 import すること — 出所を1本に保つ
// （このファイルが持つのは刻印の形だけで、値の語彙は台帳側が持つ）。
