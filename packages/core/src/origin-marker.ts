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

/**
 * 刻印が本文へ入り始めた境界時刻（Issue #857）。
 *
 * **`scripts/check-pr-origin-core.mjs` の `ORIGIN_GATE_SINCE` と同じ値・同じ名前
 * である。** 名前をわざと揃えてあるのは、片方を `grep -rn ORIGIN_GATE_SINCE` した
 * 者が必ずもう片方に当たるようにするためである。**値の正本はあちら側の宣言**
 * （境界をいつから効かせるかは人間の判断であって、こちらが測り直す性質のもので
 * はない。理由の全文はあちらの doc に在る）。
 *
 * **なぜ2箇所に在るのか（コピーではなく、写しであると名乗る）。** あちらは
 * `check-*-core.mjs` の約束で**依存を1本も持てない**（import 文が0本）ので、
 * TypeScript のこのファイルを読めない。逆にこちら（`packages/core` の中から
 * 読まれる `digest.ts`）が `scripts/` の素の `.mjs` を import すると、
 * パッケージの境界と `dist/` の build を跨ぐことになる。⟹ **写しを置くしかない。**
 * だから「2箇所に同じ値が在って誰も見張っていない」状態を作らないための歯を
 * 添えてある——`scripts/check-pr-origin.test.ts` の
 * 「刻印の境界時刻は2実装で同じ値である（#857）」が、両側を import して
 * 突き合わせる（`mutate-core-strip-ansi.test.ts` が素の `.mjs` を
 * `@ts-expect-error` 付きで読んで2実装を見張っているのと同じ形）。
 *
 * **この値が答えるのは「照合できる時代か」だけである。** この時刻より後に
 * 始まった委譲の PR / Issue には刻印が入りうる（＝ id で引ける）が、
 * **引けたかどうかと成果が在るかどうかは別の話である**——刻印を持たない成果
 * （枝だけ・コミットだけ）や、そもそも PR を作らない依頼（調査・レビュー）が
 * 実在する（Issue #857 の実例3）。字面の側（`digest.ts` の
 * `describeUnobservedOutcome`）がそれを毎回名乗る。
 */
export const ORIGIN_GATE_SINCE = '2026-09-11T20:00:00Z';
