import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * **作業ツリーの中の共有の置き場は、git・prettier・eslint・docker（`.dockerignore`）の
 * すべてから外れていなければならない。**
 *
 * 4つの一覧（`.gitignore` / `.prettierignore` / `eslint.config.js` の `ignores` /
 * `.dockerignore`）は別々に手で書くので、1つだけ足し忘れる形が繰り返し起きた。
 * - #1819 は `.scratch/` を git と prettier にだけ足した → `.scratch/` に `.ts` を置くと
 *   `pnpm lint` が落ちた（#1830 で eslint に、#1836 で docker に足した）
 * - その後の横断レビューで、`workspace`（対象のリポジトリの clone）・`coverage`・
 *   `.pnpm-store`・`.mutation-testing` も、eslint と docker から外れていないと分かった
 *
 * ⟹ 置き場を1つずつ問うのではなく、**共有の置き場の一覧（`SHARED`）を4つの道具で同時に
 * 問う。** そして `.gitignore` に新しい置き場が足されたら、`SHARED` に載せるか、理由を
 * つけて `NOT_SHARED` に載せるかを決めないと赤になるようにする（最後の歯）。
 *
 * **ファイルは作らない。** git / prettier / eslint は「このパスを無視するか」をパスだけで
 * 答えられる（`git check-ignore` / `prettier.getFileInfo` / `ESLint#isPathIgnored`）。
 * `.dockerignore` を判定する API は依存に無いので、行を読んで判定する。
 */

interface Shared {
  /** `.gitignore` に書いてある名前（末尾の `/` は外す）。 */
  readonly name: string;
  /** ディレクトリか（eslint で `.ts` を、prettier で `.md` を中に置いて問う）。 */
  readonly dir: boolean;
}

const SHARED: readonly Shared[] = [
  { name: '.scratch', dir: true },
  { name: 'workspace', dir: true },
  { name: 'coverage', dir: true },
  { name: '.pnpm-store', dir: true },
  { name: '.mutation-testing', dir: true },
  { name: 'node_modules', dir: true },
  { name: 'dist', dir: true },
  { name: '.idea', dir: true },
  { name: '.vscode', dir: true },
  { name: 'MUTATION-IN-PROGRESS.json', dir: false },
];

/**
 * `.gitignore` にあるが、4つの道具すべてから外す必要は無いもの。足すときは理由を書く。
 */
const NOT_SHARED: ReadonlyMap<string, string> = new Map([
  ['.env', '秘密の値の置き場。docker は別に外している（.env / .env.*）。lint も format もしない'],
  ['.env.*', '同上'],
  ['!.env.example', '否定の行（.env.example はコミットする）'],
  ['*.tsbuildinfo', 'tsc の生成物。拡張子の規則で、置き場ではない'],
  ['*.log', 'ログ。拡張子の規則で、置き場ではない（docker は別に外している）'],
  ['.DS_Store', 'macOS の生成物。lint も format もしない'],
  ['packages/api-client/src/generated', '生成物。パスの決まった1箇所で、共有の置き場ではない'],
  ['packages/core/src/generated', '同上'],
]);

function dockerExcludes(name: string): boolean {
  const lines = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  // docker の `**/` は0個以上のディレクトリに当たるので、根の `<name>` も含む。
  return lines.some((line) => [name, `${name}/`, `**/${name}`, `**/${name}/`].includes(line));
}

function probeOf(shared: Shared, ext: string): string {
  return shared.dir ? `${shared.name}/nested/probe.${ext}` : shared.name;
}

describe('共有の置き場は git・prettier・eslint・docker のすべてから外れている', () => {
  it.each(SHARED)('git は $name を無視する', (shared) => {
    // `check-ignore` は無視されるなら exit 0、されないなら exit 1 で投げる。
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', '--no-index', probeOf(shared, 'ts')], {
        cwd: ROOT,
      }),
    ).not.toThrow();
  });

  it.each(SHARED)('prettier は $name を無視する', async (shared) => {
    // `prettier --check .` は既定で `.gitignore` と `.prettierignore` の両方を読むので、
    // ここでも両方を渡す。
    const info = await prettier.getFileInfo(join(ROOT, probeOf(shared, 'md')), {
      ignorePath: [join(ROOT, '.gitignore'), join(ROOT, '.prettierignore')],
    });
    expect(info.ignored).toBe(true);
  });

  it.each(SHARED.filter((shared) => shared.dir))('eslint は $name を無視する', async (shared) => {
    const eslint = new ESLint({ cwd: ROOT });
    // 【赤の意味】eslint.config.js の ignores にこの置き場が無い。そこに置いた `.ts` で
    // `pnpm lint`（ひいては `pnpm verify`）が落ちる。
    expect(await eslint.isPathIgnored(join(ROOT, probeOf(shared, 'ts')))).toBe(true);
  });

  it.each(SHARED)('.dockerignore は $name を外す', (shared) => {
    // 【赤の意味】.dockerignore にこの置き場が無い。中身がビルドの文脈へ送られ、
    // `COPY . .` でイメージに焼かれうる。
    expect(dockerExcludes(shared.name)).toBe(true);
  });

  it('.gitignore の置き場は、すべて SHARED か NOT_SHARED のどちらかに分けてある', () => {
    const entries = readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.replace(/\/$/, ''));
    expect(entries.length).toBeGreaterThan(0);
    const shared = new Set(SHARED.map((s) => s.name));
    const unclassified = entries.filter((entry) => !shared.has(entry) && !NOT_SHARED.has(entry));
    // 【赤の意味】.gitignore に新しい置き場が足されたが、ほかの3つの道具から外すかを
    // 決めていない。SHARED に足す（4つすべてから外す）か、理由をつけて NOT_SHARED に足すこと。
    expect(unclassified).toEqual([]);
  });
});
