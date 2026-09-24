import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * テストが `tmpdir()` の下に作る一時ディレクトリを、そのテストファイルの実行が
 * 終わった時点で自動的に消す共通の入り口（#1436 案B）。
 *
 * ## 使い方
 * 直接 `mkdtemp` / `mkdtempSync` を呼ぶ代わりに、ここの `makeTempDir` /
 * `makeTempDirSync` を呼ぶ。作ったパスは消さなくてよい —
 * `vitest.setup.ts` が登録する `afterAll` がテストファイルの最後に
 * まとめて掃除する（下の「なぜ afterEach ではないか」を参照）。
 *
 * ```ts
 * import { makeTempDir } from '../../vitest.tmpdir.js'; // 深さは呼び出し元次第
 *
 * it('...', async () => {
 *   const dir = await makeTempDir('alteroid-example-');
 *   // dir を使うだけでよい。rm(dir, …) は書かなくてよい。
 * });
 * ```
 *
 * `scripts/no-direct-mkdtemp-core.mjs`（静的な歯）が、テストファイルが
 * `mkdtemp` / `mkdtempSync` を直接呼んでいないかを見張る。**新しく書く
 * テストはここを通ること** — 許可リストに載っている既存の呼び出しは
 * 移行待ちで、新規はここを経由しない限り歯が赤くなる。
 *
 * ## なぜ `afterEach` ではなく `afterAll` か
 * Issue #1436 が挙げていた懸念のひとつ — `beforeAll` で1つ作って複数の
 * `it` にまたがって使っている箇所（例:
 * `packages/core/src/clone.test.ts` の `#696`/`#698` 用 `firePreCompact`
 * や、この repo の多くのテストファイルが採る「トップレベルの `beforeEach`/
 * `beforeAll` で1つ作り、ファイル内のどの `it` からも読む」形）。
 * `afterEach` で消すと、2本目以降の `it` が読もうとした時点でもう無い。
 * だから掃除は「そのテストファイルの最後」まで待つ必要があり、単位は
 * ファイルである。
 *
 * ## なぜこれでファイルをまたいで安全か（実測、vitest 4.1.11）
 * `pool: 'forks'` / `isolate: true`（この repo の既定。`vitest.config.ts` は
 * どちらも上書きしていない）のもとで、次の2点を実測で確かめてある
 * （手順と生出力は PR 本文）。
 *
 * 1. **モジュールスコープの状態はテストファイルをまたいで残らない。**
 *    同じモジュールを import する2つのテストファイルを
 *    `--maxWorkers=1`（同一プロセス内で直列に実行させる設定）で
 *    走らせても、後発のファイルの `afterAll` は先発のファイルが積んだ
 *    値を見なかった。⟹ この下の `createdThisFile` は「そのテスト
 *    ファイル1本ぶん」のスコープであり、他のファイルが作ったパスを
 *    誤って消すことはない。
 * 2. **`setupFiles` 側の `afterAll` は、テストファイル自身が登録した
 *    `afterAll` より後に走る。** これは `vitest.setup.ts` の既存の
 *    jsdom 用の歯が同じ前提（「global setup の `afterEach` は、各
 *    ファイル自身の `afterEach` より後に走る」）を既に使っており、
 *    `afterAll` でも同じ順序であることを実測で確認した。⟹
 *    `beforeAll` で作って `it` が読み、ファイル自身では後片付けしない
 *    形でも、ファイル自身の `afterAll`／`afterEach` がすべて終わった
 *    あとにここで掃除できる。
 *
 * ## 残す口
 * 失敗を調べるために消さずに残したいときは環境変数
 * `ALTEROID_KEEP_TEST_TMPDIRS=1` を立てる。掃除だけをスキップし、
 * 記録そのものは空にする（同じファイルを再度読んでも二重には残さない）。
 * 残したパスは `process.stderr.write` で報告する（stdout ではない —
 * 本物の stdout へ書くとこのファイル自身が持つ #314 の歯に落ちるため）。
 *
 * ## 子プロセスの限界
 * シェルスクリプトや別プロセスが自分で作る一時ディレクトリ（例:
 * `railway/*.sh` を spawn するテストが子の中で作るもの）はこの土台の外に
 * ある。ここが記録できるのは「このテストファイルのプロセス自身が
 * `makeTempDir` / `makeTempDirSync` を呼んで作ったパス」だけである。
 */

const KEEP_ENV_VAR = 'ALTEROID_KEEP_TEST_TMPDIRS';

/** そのテストファイル（＝この module のインスタンス）が作った一時ディレクトリ。 */
let createdThisFile: string[] = [];

/** `tmpdir()` の下に一時ディレクトリを非同期に作る。`mkdtemp` を直接呼ばない。 */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdThisFile.push(dir);
  return dir;
}

/** `tmpdir()` の下に一時ディレクトリを同期に作る。`mkdtempSync` を直接呼ばない。 */
export function makeTempDirSync(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdThisFile.push(dir);
  return dir;
}

/**
 * `vitest.setup.ts` の `afterAll` から呼ぶ。そのテストファイルが作った
 * ぶんを消し、記録を空にする。`ALTEROID_KEEP_TEST_TMPDIRS=1` のときは
 * 消さずに記録だけ空にする。
 *
 * 掃除そのもの（他ファイルからも呼べる）としてではなく、**呼ばれる場所は
 * `vitest.setup.ts` の1箇所だけにする** —— 各テストファイルが自分でも
 * 呼べる形にすると、「呼べば効くが呼び忘れれば何も起きない」もの
 * （`vitest.setup.ts` 冒頭の stdout の歯が避けている形）が増えるだけで
 * ある。
 */
export async function drainCreatedTempDirsForCurrentFile(): Promise<{
  dirs: readonly string[];
  kept: boolean;
}> {
  const dirs = createdThisFile;
  createdThisFile = [];
  const kept = process.env[KEEP_ENV_VAR] === '1';
  if (kept) {
    if (dirs.length > 0) {
      process.stderr.write(
        `vitest.tmpdir: ${KEEP_ENV_VAR}=1 のため ${dirs.length} 件を消さずに残した:\n` +
          dirs.map((d) => `  ${d}`).join('\n') +
          '\n',
      );
    }
    return { dirs, kept: true };
  }
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  return { dirs, kept: false };
}

/**
 * 単体テスト用— 掃除をせずに、現在このファイルが記録している内容だけを覗く。
 * 本体（`makeTempDir` / `makeTempDirSync` / `drainCreatedTempDirsForCurrentFile`）の
 * 動きを確かめる `vitest.tmpdir.test.ts` の外から呼ぶ用途は無い。
 */
export function peekCreatedTempDirsForTesting(): readonly string[] {
  return createdThisFile;
}
