/**
 * `check-web-bundle-node-traces.mjs` の判定だけを切り出したもの
 * （`verify.mjs` / `verify-core.mjs` と同じ分け方）。
 *
 * **切り出したのはテストのためである。** 判定を CLI 側に置いたままだと、
 * 歯を試すには `pnpm build` から始まる一式を実際に走らせるしかなく、
 * **測りたいもの（パターンが当たるか・当たらないか）より桁違いに重いものを
 * 毎回走らせることになる。** ここへ置けば、実ファイルを読まずに合成した
 * 文字列で判定だけを試せる。
 *
 * **検査語を選んだ理由・言えないことは `check-web-bundle-node-traces.mjs` の
 * doc が正本。** ここには判定ロジックだけを置く。
 */

/** 引用符付きの `node:` import 指定子だけを見る（部分一致による誤検知を避けた理由は CLI 側の doc）。 */
export const NODE_SPECIFIER = /["']node:[a-zA-Z0-9/_-]+["']/;

export const PATTERNS = [
  { name: 'createRequire', re: /createRequire/ },
  { name: 'node: 指定子(引用符付き)', re: NODE_SPECIFIER },
  { name: 'process.cwd', re: /process\.cwd/ },
  { name: 'Bun.', re: /Bun\./ },
];

/**
 * `files`（`{ path, content }` の配列）を全パターンで走査し、当たった箇所を返す。
 * 1ファイルにつき1パターン最大1件（`RegExp#exec` を使い切らない。個数ではなく
 * 「混入したかどうか」だけを見る検査なので、件数の精度は求めていない）。
 */
export function findNodeTraceHits(files) {
  const hits = [];
  for (const file of files) {
    for (const pattern of PATTERNS) {
      const match = pattern.re.exec(file.content);
      if (match !== null) {
        hits.push({
          path: file.path,
          pattern: pattern.name,
          snippet: file.content.slice(Math.max(0, match.index - 40), match.index + 60),
        });
      }
    }
  }
  return hits;
}
