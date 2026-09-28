import { register } from 'node:module';
import type { ResolveHook } from 'node:module';

/**
 * 子プロセスに `--import=<このファイル>` として渡す（他のオプションは
 * `child-src.test-support.ts` の `runChildAgainstSrc` が組み立てる）。
 *
 * **やること・やらないこと。** Node の `--experimental-strip-types` は TS の
 * 型構文を剥がすだけで、`./x.js` という specifier を `./x.ts` へ読み替える
 * ことはしない —— TS は相対 import をビルド後の拡張子（`.js`）で書く約束
 * なので、`src/*.ts` のまま剥がして走らせると、剥がした本体の中の相対
 * import が解決できずに `ERR_MODULE_NOT_FOUND` で落ちる（実測: このモジュール
 * を経由せずに `./uncaught-net.ts` を子プロセスへ直接食わせると、隣の
 * `./dropped-record.js` が見つからないと言われて落ちる）。
 *
 * この resolve hook は、相対 import の specifier が `.js` で終わり、かつ
 * 既定の解決が `ERR_MODULE_NOT_FOUND` で失敗したときに限って、同じ
 * specifier を `.ts` へ読み替えて再試行する。**それ以外の失敗（本当に
 * 存在しないモジュール・別の理由の解決失敗）はそのまま投げ直す** ——
 * 「見つからない」を握り潰して別の見つからなさへすり替えないため。
 *
 * **自己登録。** `register(import.meta.url)` で自分自身を hook として
 * 登録している。別ファイルへ実装を分けない理由は、「どのファイルが
 * `--import` の対象で、どのファイルが hook 本体か」を1ファイルに保つ
 * ため（`register` の呼び先を探しに行かずに済む）。
 */
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const isRelativeJsImport =
    specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'));
  if (!isRelativeJsImport) {
    return nextResolve(specifier, context);
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
    const tsSpecifier = `${specifier.slice(0, -'.js'.length)}.ts`;
    return nextResolve(tsSpecifier, context);
  }
};

register(import.meta.url);
