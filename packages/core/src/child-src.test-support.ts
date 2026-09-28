import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, 'child-src-loader.test-support.ts');

/** `run(process.execPath, [...])` が失敗したときに返す形（成功時は `null`）。 */
export interface ChildSrcFailure {
  code?: number;
  stderr?: string;
}

/**
 * 未捕捉の例外・未処理の拒否のように「本物のプロセスが実際に死ぬこと」を
 * 観測したい歯のための、子プロセスの起こし方（#1908）。
 *
 * **同じプロセスで検査しない理由は変わっていない** —— `schedule.test.ts` の
 * 「刻みの中で投げたとき」の doc にあるとおり、投げ直した先は未処理の拒否
 * になるので、同じ vitest プロセスで走らせると vitest 自身の unhandled
 * error の歯に引っかかる。**子プロセスで測ること自体は直していない。**
 *
 * **直したのは import 元である。** 以前はここで本物のチェックアウトの
 * `packages/core/dist/index.js` を読んでいた（#1908）。これには2つの弱さが
 * あった —— (1) 同じツリーで並行して走る `pnpm build` の tsup clean が
 * `dist/*.js` を一瞬消す窓と競合する（#204 / #234）、(2) `src` だけを直して
 * build せずにこの歯だけ回すと、古い `dist` に対して緑が出る。
 *
 * いまは子プロセスに **いまの `src/*.ts` を直接** 読ませる。Node 22 の型剥がし
 * （`--experimental-strip-types`）と、`.js` の相対 import を `.ts` へ読み替える
 * `child-src-loader.test-support.ts` の resolve hook を組み合わせている ——
 * 詳しい理由と限界はそちらの doc に書いてある。**依存を増やしていない**
 * （node の組み込みだけで完結する）。
 *
 * @param lines 子プロセスへ `-e` で渡す ESM のソース（行の配列。呼び出し側は
 *   `entryUrl(import.meta.url, '<対象ファイル名>.ts')` で作った絶対パスを
 *   `import` する行を含めること）。
 */
export async function runChildAgainstSrc(
  lines: readonly string[],
): Promise<ChildSrcFailure | null> {
  const child = lines.join('\n');
  return run(process.execPath, [
    '--experimental-strip-types',
    `--import=${loader}`,
    '--input-type=module',
    '-e',
    child,
  ]).then(
    () => null,
    (error: unknown) => error as ChildSrcFailure,
  );
}

/**
 * 呼び出し側（`<対象>.test.ts`、`src/` 直下にある前提）の `import.meta.url` から、
 * 同じ `src/` 直下に在る `<name>`（例: `'schedule.ts'`）への絶対パスを作る。
 * 子プロセスの `import` 文はこのパスを `JSON.stringify` して埋め込む
 * （テストファイルからの相対パスではなく絶対パスにするのは、子プロセスの
 * cwd に依存させないため）。
 */
export function siblingSrcPath(testFileUrl: string, name: string): string {
  return join(dirname(fileURLToPath(testFileUrl)), name);
}
