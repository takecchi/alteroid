import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * **`.scratch/`（担い手・作業者が作業ツリーの中に置く使い捨ての置き場）は、git・
 * prettier・eslint・docker（`.dockerignore`）のすべてから外れていなければならない。**
 *
 * #1819 は `.gitignore` と `.prettierignore` にだけ足した。`eslint.config.js` の
 * `ignores` は `.gitignore` を読まない別の一覧なので、`.scratch/` に `.ts` を置くと
 * `pnpm lint`（ひいては `pnpm verify`）が落ちた（16回目の横断レビュー）。3つの一覧は
 * 別々に手で書くので、1つだけ足し忘れる形がまた起きる。ここで3つを同時に問う。
 *
 * **ファイルは作らない。** 3つとも「このパスを無視するか」を、パスだけで答えられる
 * （`git check-ignore` / `ESLint#isPathIgnored` / `prettier.getFileInfo`）。本物の
 * `.scratch/` に書き込むと、同じツリーで作業している人の置き場を汚すので避ける。
 */
const PROBES = ['.scratch/probe.ts', '.scratch/nested/probe.tsx', '.scratch/notes.md'];

describe('.scratch/ は git・prettier・eslint・docker のすべてから外れている', () => {
  it.each(PROBES)('git は %s を無視する', (path) => {
    // `check-ignore` は無視されるなら exit 0、されないなら exit 1 で投げる。
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: ROOT }),
    ).not.toThrow();
  });

  it.each(PROBES)('prettier は %s を無視する', async (path) => {
    const info = await prettier.getFileInfo(join(ROOT, path), {
      ignorePath: join(ROOT, '.prettierignore'),
    });
    expect(info.ignored).toBe(true);
  });

  it.each(PROBES.filter((path) => /\.tsx?$/.test(path)))(
    'eslint は %s を無視する',
    async (path) => {
      const eslint = new ESLint({ cwd: ROOT });
      // 【赤の意味】eslint.config.js の ignores に `.scratch/` が無い。`.scratch/` に
      // 置いた `.ts` で `pnpm lint` が落ちる。
      expect(await eslint.isPathIgnored(join(ROOT, path))).toBe(true);
    },
  );

  /**
   * **docker のビルドの文脈からも外す**（`.scratch/` の下書きをイメージへ焼かない）。
   * `.dockerignore` を判定する API は依存に無いので、行を読んで、`.scratch` を外す
   * 行（`.scratch` / `.scratch/` / `**\/.scratch` / `**\/.scratch/`）があるかを見る。
   * docker の `**\/` は0個以上のディレクトリに当たるので、根の `.scratch` も含む。
   */
  it('.dockerignore は .scratch を外す', () => {
    const lines = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    const excludes = lines.some((line) =>
      ['.scratch', '.scratch/', '**/.scratch', '**/.scratch/'].includes(line),
    );
    // 【赤の意味】.dockerignore に `.scratch` が無い。作業者の下書きがビルドの文脈へ
    // 送られ、イメージに焼かれうる。
    expect(excludes).toBe(true);
  });
});
