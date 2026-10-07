import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import { gitChildEnv } from './git-child-env.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ファイルは作らない: git / prettier / eslint はパスだけで無視を答えられ、`.dockerignore` は判定 API が依存に無いため行を読んで判定する。

interface Shared {
  readonly name: string;
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
  { name: 'storybook-static', dir: true },
  { name: '.idea', dir: true },
  { name: '.vscode', dir: true },
  { name: 'MUTATION-IN-PROGRESS.json', dir: false },
];

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
  return lines.some((line) => [name, `${name}/`, `**/${name}`, `**/${name}/`].includes(line));
}

function probeOf(shared: Shared, ext: string): string {
  return shared.dir ? `${shared.name}/nested/probe.${ext}` : shared.name;
}

describe('共有の置き場は git・prettier・eslint・docker のすべてから外れている', () => {
  it.each(SHARED)('git は $name を無視する', (shared) => {
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', '--no-index', probeOf(shared, 'ts')], {
        cwd: ROOT,
        env: gitChildEnv(),
      }),
    ).not.toThrow();
  });

  it.each(SHARED)('prettier は $name を無視する', async (shared) => {
    // 両方を渡す: `prettier --check .` が既定で `.gitignore` と `.prettierignore` の両方を読むため。
    const info = await prettier.getFileInfo(join(ROOT, probeOf(shared, 'md')), {
      ignorePath: [join(ROOT, '.gitignore'), join(ROOT, '.prettierignore')],
    });
    expect(info.ignored).toBe(true);
  });

  it.each(SHARED.filter((shared) => shared.dir))('eslint は $name を無視する', async (shared) => {
    const eslint = new ESLint({ cwd: ROOT });
    expect(await eslint.isPathIgnored(join(ROOT, probeOf(shared, 'ts')))).toBe(true);
  });

  it.each(SHARED)('.dockerignore は $name を外す', (shared) => {
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
    expect(unclassified).toEqual([]);
  });
});
