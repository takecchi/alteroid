/**
 * `react/jsx-runtime` を ESM の名前付き export として包み直したもの（`vite.config.ts` の
 * `jsxRuntimeAsEsm` が、クライアントのビルドでだけ差し替える）。
 *
 * React 19 の `react/jsx-runtime` は CommonJS である。そのまま束ねると、JSX の1つ1つが
 * 名前空間オブジェクト越しの `(0,M.jsx)(…)` の形で呼ばれる（CommonJS の `this` を外すための形）。
 * ここで1度だけ取り出して `const` で export すると、呼ぶ側は ESM の名前付き import になり、
 * `t(…)` の形に縮む。実測（main 632eb1fa 相当）: `(0,X.jsx)` の形の呼び出しが 2,467 箇所、
 * その文字だけで 29,470 B あった。
 *
 * 渡しているのは React 自身の関数そのもので、挙動は変わらない。`jsxDEV`（開発時の
 * `react/jsx-dev-runtime`）は本番のビルドで使われないので包まない。
 */
import * as runtime from 'react/jsx-runtime';

export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const Fragment = runtime.Fragment;
