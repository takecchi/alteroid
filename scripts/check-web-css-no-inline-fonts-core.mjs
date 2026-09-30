/**
 * `check-web-css-no-inline-fonts.mjs` の判定だけを切り出したもの
 * （`check-web-css-comment-classnames-core.mjs` と同じ分け方・同じ理由 — 本物の
 * ビルドを走らせずに、合成した文字列で当たり判定だけを確かめられるようにする）。
 *
 * ## 何を検査語に選んだか
 *
 * 検査語は「コンパイル後の CSS の中の `data:font/`」。フォントを CSS へ base64 で
 * 埋め込むと `url(data:font/woff2;base64,…)` の形になる。
 *
 * **なぜ埋め込むと困るか。** 埋め込まれた断片は `unicode-range` に関係なく、CSS と
 * 一緒に最初に落ちてくる。`@font-face` の `unicode-range` が効くのは `/assets/…` の
 * URL 参照の断片だけで、「画面が実際に使う字の断片しか落ちてこない」という想定が
 * 埋め込み分には効かない。実測（PR #2357）: 埋め込みを止める前は
 * `apps/web/build/client/assets/root-*.css` に `url(data:font/…)` が 46 個・約 200 KB
 * 入っていた。
 *
 * **原因の候補は `apps/web/vite.config.ts` の `build.assetsInlineLimit`。** 既定
 * （4096 B 未満は base64 化）に戻ると、小さいフォント断片が埋め込まれる。
 *
 * ## この検査が言えること・言えないこと
 *
 * - **言えること**: コンパイル後の CSS に `data:font/` が1つも無い。原因を直接塞ぐ
 *   検査なので、CSS 全体のサイズ予算より誤って落ちにくい
 * - **言えないこと**: CSS のサイズが小さいこと。フォント以外の埋め込み（画像など）や
 *   別の原因での肥大は見ない（オーナー判断でサイズ予算は入れていない）。
 *   `data:application/font-woff` のような別の MIME で埋め込まれた場合も拾わない
 */

/** フォントの base64 埋め込み（`url(data:font/woff2;base64,…)` の頭）。 */
export const INLINE_FONT = /data:font\//;

export const PATTERNS = [{ name: 'inline-font-data-url', re: INLINE_FONT }];

/**
 * 落ちたときに CLI が添える説明（原因の候補と、なぜ困るか）。
 */
export const FAILURE_ADVICE =
  '原因の候補: apps/web/vite.config.ts の build.assetsInlineLimit（フォントを埋め込まない関数形が外れていないか）。' +
  '埋め込むと困る理由: unicode-range に関係なく、CSS と一緒に最初に落ちてくる（画面が使わない断片まで先に落ちる）。';

/**
 * `files`（`{ path, content }` の配列）を走査し、`data:font/` が現れる箇所を返す。
 * 1ファイルにつき1件（`count` に個数を持つ）。CSS が0本なら空配列ではなく呼び側で
 * 落とす（空で緑にしない）ため、`assertHasCssFiles` を使う。
 */
export function findInlineFontHits(files) {
  const hits = [];
  for (const file of files) {
    const global = new RegExp(INLINE_FONT.source, 'g');
    const matches = [...file.content.matchAll(global)];
    if (matches.length > 0) {
      const first = matches[0].index;
      hits.push({
        path: file.path,
        pattern: PATTERNS[0].name,
        count: matches.length,
        snippet: file.content.slice(Math.max(0, first - 40), first + 40),
      });
    }
  }
  return hits;
}

/**
 * 検査対象の CSS が0本のときは「検査していない」のであって「0件だった」ではない。
 * 落とす理由の文字列を返す（問題なければ null）。
 */
export function assertHasCssFiles(files) {
  return files.length === 0 ? 'CSS が1つも無い（build が壊れていないか）' : null;
}
