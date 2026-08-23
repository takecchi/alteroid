import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- vitest.config.ts は defineConfig({...}) を素通しするだけなので、
// テストから直接読める。include を書き写すと二重管理でずれるので、ここから読む。
import rootVitestConfig from '../vitest.config.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 変異試験でだけ拾いたくないので、探索から外すもの。 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router']);

/** `scripts/*.test.ts` に置く8ワークスペースの入り口が揃っているか。 */
function readWorkspaceGlobs(): string[] {
  const text = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start === -1) {
    throw new Error('pnpm-workspace.yaml に `packages:` が見つからない');
  }
  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+(\S+)\s*$/);
    if (!m) break; // インデントされた `- ` の並びが終わったら打ち切る
    globs.push(m[1]);
  }
  if (globs.length === 0) {
    throw new Error('pnpm-workspace.yaml の `packages:` が空に見える');
  }
  return globs;
}

/** `<dir>/*` 形式の workspace glob を、実在する package.json を持つディレクトリへ展開する。 */
function expandWorkspaceDirs(globs: string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    const m = glob.match(/^(.+)\/\*$/);
    if (!m) {
      throw new Error(`このテストが対応していない workspace glob 形式: ${glob}`);
    }
    const base = path.join(ROOT, m[1]);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = `${m[1]}/${entry.name}`;
      if (existsSync(path.join(ROOT, pkgDir, 'package.json'))) {
        dirs.push(pkgDir);
      }
    }
  }
  return dirs.sort();
}

/** repo 全体をファイル単位で読み、リポジトリ根からの相対パス（`/` 区切り）で返す。 */
function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
}

/**
 * `node ../../scripts/test.mjs --root=<...> <path>` の形の script から絞り込み先の
 * パスを取り出す。
 *
 * **#311 でこの形が変わった。** 以前は `vitest run --root=<...> <path>` だったが、
 * `describe.skip` / `it.skip` で全部飛ばしても exit 0 のまま緑になる欠陥を塞ぐため、
 * vitest を直呼びせずラッパ（`scripts/test.mjs`）を経由するようにした
 * （`scripts/test-guard-core.mjs` の doc）。**この歯が見ている3つの性質は変えていない**
 * — script が在るか・自分自身のパッケージを指しているか・絞り込み先にテストが実在するか。
 * 変わったのは、それを読み取る正規表現の形だけである。
 */
const TEST_SCRIPT_SHAPE = /^node \.\.\/\.\.\/scripts\/test\.mjs --root=\S+\s+(\S+)$/;

const workspaceDirs = expandWorkspaceDirs(readWorkspaceGlobs());

const includeGlobs = (rootVitestConfig as { test: { include: string[] } }).test.include;

const allFiles: string[] = [];
collectFiles(ROOT, allFiles);

/** root の vitest.config.ts の include に実際に拾われるファイルだけ。 */
const testFiles = allFiles.filter((f) => includeGlobs.some((g) => path.matchesGlob(f, g)));

/**
 * #246: `apps/web` に `test` script が無く、`pnpm --filter @alteroid/web test` が
 * 出力0行・exit 0 で「通った」ように見えた（AGENTS.md「静かに失敗する道具」そのもの）。
 *
 * 直しは2つに分かれている。
 * 1. 8ワークスペース全部の `package.json` に `test` script を足した（この歯の外側）
 * 2. **その仕組みが次に足されるパッケージでも保たれることを、ここで機械的に確かめる**
 *
 * 見る性質は3つ、どれも「静かに壊れる」形である。
 * - workspace に `test` script が無い（→ `pnpm --filter <pkg> test` が出力0行・exit 0 に戻る）
 * - `test` script のフィルタが別のパッケージを指している（コピペ由来。そのパッケージの
 *   テストを1本も見ずに緑を返す）
 * - フィルタの先に、root の include と一致するファイルが1本も無い（「テストが在る」と
 *   思っている場所が空になっている。vitest 自身は0件で exit 1 になるが、それに気づく前に
 *   別の変更でここが壊れたことは検出できる）
 *
 * **この歯が保証するのは「テストが走ること」までで、「走ったテストが何か測っていること」
 * ではない。** `describe.skip` / `it.skip` で中身を全部飛ばしたファイルは、この歯が見る
 * 3条件をすべて満たしたまま（`test` script は在る・自分を指す・ファイルも実在する）
 * exit 0 で緑になる。これは別原因の別穴として #311 に切ってある。
 */
describe('workspace の test script が同じ穴を開けていないか（#246）', () => {
  it('少なくとも1つの workspace package を見つけている（このテストの前提）', () => {
    expect(workspaceDirs.length).toBeGreaterThan(0);
  });

  it('root の vitest.config.ts から include を読めている（このテストの前提）', () => {
    expect(Array.isArray(includeGlobs)).toBe(true);
    expect(includeGlobs.length).toBeGreaterThan(0);
  });

  it.each(workspaceDirs)('%s: package.json に test script がある', (pkgDir) => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, pkgDir, 'package.json'), 'utf8'));
    expect(pkg.scripts?.test, `${pkgDir}/package.json の scripts.test が無い`).toBeTruthy();
  });

  it.each(workspaceDirs)('%s: test script が自分自身のパッケージを指している', (pkgDir) => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, pkgDir, 'package.json'), 'utf8'));
    const script = pkg.scripts?.test;
    expect(script, `${pkgDir}/package.json の scripts.test が無い`).toBeTruthy();

    const match = (script as string).match(TEST_SCRIPT_SHAPE);
    expect(
      match,
      `${pkgDir} の test script の形が想定外: ${JSON.stringify(script)}`,
    ).not.toBeNull();

    const filterPath = match![1];
    const pointsToOwnPackage = filterPath === pkgDir || filterPath.startsWith(`${pkgDir}/`);
    expect(
      pointsToOwnPackage,
      `${pkgDir} の test script が別のパッケージを指している（絞り込み先: ${filterPath}）`,
    ).toBe(true);
  });

  it.each(workspaceDirs)(
    '%s: test script の絞り込み先に、root の include と一致するテストが実在する',
    (pkgDir) => {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, pkgDir, 'package.json'), 'utf8'));
      const script = pkg.scripts?.test;
      expect(script, `${pkgDir}/package.json の scripts.test が無い`).toBeTruthy();

      const match = (script as string).match(TEST_SCRIPT_SHAPE);
      expect(
        match,
        `${pkgDir} の test script の形が想定外: ${JSON.stringify(script)}`,
      ).toBeTruthy();

      const filterPath = match![1];
      const matched = testFiles.filter((f) => f === filterPath || f.startsWith(`${filterPath}/`));
      expect(
        matched.length,
        `${pkgDir} の test script（絞り込み先: ${filterPath}）に一致するテストファイルが0件`,
      ).toBeGreaterThan(0);
    },
  );
});
