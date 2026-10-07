import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- vitest.config.ts は defineConfig({...}) を素通しするだけなので、
// テストから直接読める。include を書き写すと二重管理でずれるので、ここから読む。
import rootVitestConfig from '../vitest.config.ts';

import { collectRepoFiles } from './repo-scan-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router']);

function readWorkspaceGlobs(): string[] {
  const text = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start === -1) {
    throw new Error('pnpm-workspace.yaml に `packages:` が見つからない');
  }
  const globs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^\s+-\s+(\S+)\s*$/);
    if (!m) break;
    const value = m[1];
    if (value === undefined) break;
    globs.push(value);
  }
  if (globs.length === 0) {
    throw new Error('pnpm-workspace.yaml の `packages:` が空に見える');
  }
  return globs;
}

function expandWorkspaceDirs(globs: string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    const m = glob.match(/^(.+)\/\*$/);
    if (!m) {
      throw new Error(`このテストが対応していない workspace glob 形式: ${glob}`);
    }
    const prefix = m[1];
    if (prefix === undefined) {
      throw new Error(`このテストが対応していない workspace glob 形式: ${glob}`);
    }
    const base = path.join(ROOT, prefix);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = `${prefix}/${entry.name}`;
      if (existsSync(path.join(ROOT, pkgDir, 'package.json'))) {
        dirs.push(pkgDir);
      }
    }
  }
  return dirs.sort();
}

const TEST_SCRIPT_SHAPE = /^node \.\.\/\.\.\/scripts\/test\.mjs --root=\S+ --scope=(\S+)$/;

const workspaceDirs = expandWorkspaceDirs(readWorkspaceGlobs());

const includeGlobs = (rootVitestConfig as { test: { include: string[] } }).test.include;

const allFiles = collectRepoFiles(ROOT, EXCLUDE_DIRS);

const testFiles = allFiles.filter((f) => includeGlobs.some((g) => path.matchesGlob(f, g)));

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

    const filterPath = match![1]!;
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

      const filterPath = match![1]!;
      const matched = testFiles.filter((f) => f === filterPath || f.startsWith(`${filterPath}/`));
      expect(
        matched.length,
        `${pkgDir} の test script（絞り込み先: ${filterPath}）に一致するテストファイルが0件`,
      ).toBeGreaterThan(0);
    },
  );
});
