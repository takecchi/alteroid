/**
 * `check-web-css-comment-classnames.mjs` の判定だけを切り出したもの
 * （`check-web-bundle-node-traces-core.mjs` と同じ分け方・同じ理由 — 本物の
 * ビルドを走らせずに、合成した文字列で当たり判定だけを確かめられるようにする）。
 *
 * ## 何を検査語に選んだか（#317）
 *
 * Tailwind のスキャナは、ソースコードの「コメントの中」に書かれたクラス名も
 * 拾う。説明のためにコメントへ完全なクラス名（`grid-cols-[6rem_1fr]` など）を
 * 書いた場合は、使われないだけの正当な CSS が増えるだけで実害は無い。
 *
 * **問題は、コメントが省略記号などプレースホルダの記法を混ぜたときである。**
 * 実測（#317 本文・PR #304 の作業者の報告）: ソースコードのコメント中に説明
 * として `pr-[calc(...+var(--safe-right))]`（プレースホルダの `...` を含む）
 * と角括弧つきで書いたところ、Tailwind のスキャナがコメントか本物のコードかを
 * 区別せずその文字列を拾い、コンパイル後の CSS に
 * `padding-right:calc(...+var(--safe-right))` という不正な `calc()` が実際に
 * 生成された。
 *
 * **検査語は「コンパイル後の CSS の中の、リテラルな `...`（半角ピリオド3つ）
 * または `…`（全角省略記号1文字）」。** 正当な Tailwind の生成物（ユーティリティ
 * クラス・shadcn / tw-animate-css の CSS）にこの並びが出ることは無い
 * （`text-overflow: ellipsis` は語であって記号ではない）。実際にこの repo の
 * `pnpm build` 後の `apps/web/build/client/assets/*.css` で実測 0件
 * （2026-08-26、PR 本文に生の出力がある）。
 *
 * ## この検査が言えること・言えないこと
 *
 * - **言えること**: コンパイル後の CSS に、上の2つの記号のどちらも1つも無い。
 *   これは「プレースホルダを含むコメントがクラス名として拾われ、壊れた宣言が
 *   生成された」という #317 で実際に踏んだ形を再現すれば必ず捕まる
 *   （PR 本文の実測: わざと壊れたコメントを戻して赤くなることを確認済み）
 * - **言えないこと**: プレースホルダの記法は `...` / `…` だけとは限らない
 *   （例: `<値>` のような山括弧、`foo, bar, ...` のような別の省略の書き方）。
 *   この検査はそれらまでは拾わない。**網羅的な「コメントが誤って拾われた
 *   CSS」の検出ではなく、実際に一度発生した形の再発防止である**
 * - **言えないこと（その2）**: 完全なクラス名がコメントに書かれて未使用の
 *   正当な CSS が増えること自体は、この検査の対象外（実害が無いため。
 *   #317 本文の「なぜ上げるか」参照）
 */

/** リテラルな `...`（半角ピリオド3つ）または `…`（全角省略記号）。 */
export const PLACEHOLDER_ELLIPSIS = /\.\.\.|…/;

export const PATTERNS = [{ name: 'placeholder-ellipsis', re: PLACEHOLDER_ELLIPSIS }];

/**
 * `files`（`{ path, content }` の配列）を全パターンで走査し、当たった箇所を返す。
 * 1ファイルにつき1パターン最大1件（`findNodeTraceHits` と同じ割り切り —
 * 「混入したかどうか」だけを見る検査なので、件数の精度は求めていない）。
 */
export function findInvalidCssHits(files) {
  const hits = [];
  for (const file of files) {
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(file.content);
      if (match !== null) {
        hits.push({
          path: file.path,
          pattern: pattern.name,
          snippet: file.content.slice(Math.max(0, match.index - 60), match.index + 40),
        });
      }
    }
  }
  return hits;
}
