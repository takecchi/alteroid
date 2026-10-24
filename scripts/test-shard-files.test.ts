import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NO_MATCH_TEST_NAME,
  buildShardFilesVitestArgs,
  filesFromJsonReport,
  parseShardFilesArgs,
  // @ts-expect-error -- 素の .mjs
} from './test-shard-files-core.mjs';
import { collectRepoFiles } from './repo-scan-files.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/test-shard-files.mjs');

describe('parseShardFilesArgs', () => {
  it('<scope> <i>/<n> を読む（素の -- は落とす）', () => {
    expect(parseShardFilesArgs(['packages/core/src', '3/8'])).toEqual({
      ok: true,
      scope: 'packages/core/src',
      shard: '3/8',
    });
    expect(parseShardFilesArgs(['--', 'packages/core/src', '1/1'])).toMatchObject({ ok: true });
  });

  it('形が違う・範囲外は断る', () => {
    for (const argv of [
      [],
      ['packages/core/src'],
      ['packages/core/src', '3'],
      ['packages/core/src', '0/3'],
      ['packages/core/src', '4/3'],
      ['packages/core/src', '1/0'],
      ['--shard=1/3', 'packages/core/src'],
      ['packages/core/src', '1/3', 'extra'],
    ]) {
      expect(parseShardFilesArgs(argv).ok, JSON.stringify(argv)).toBe(false);
    }
  });
});

describe('buildShardFilesVitestArgs', () => {
  it('どのテストにも当たらない -t と JSON レポートで run を起こす', () => {
    expect(
      buildShardFilesVitestArgs({ scope: 'a/src', shard: '2/3', outputFile: '/x/r.json' }),
    ).toEqual([
      'run',
      'a/src',
      '--shard=2/3',
      '-t',
      NO_MATCH_TEST_NAME,
      '--reporter=json',
      '--outputFile=/x/r.json',
    ]);
  });
});

describe('filesFromJsonReport', () => {
  it('根からの相対パスを並べ替えて返す', () => {
    expect(
      filesFromJsonReport(
        { testResults: [{ name: '/r/b/x.test.ts' }, { name: '/r/a/y.test.ts' }] },
        '/r',
      ),
    ).toEqual(['a/y.test.ts', 'b/x.test.ts']);
  });

  it('testResults が読めなければ null（0件と取り違えない）', () => {
    expect(filesFromJsonReport(null, '/r')).toBeNull();
    expect(filesFromJsonReport({}, '/r')).toBeNull();
    expect(filesFromJsonReport({ testResults: 'x' }, '/r')).toBeNull();
    expect(filesFromJsonReport({ testResults: [] }, '/r')).toEqual([]);
  });
});

describe('pnpm test:shard-files（実物の vitest）', () => {
  const SCOPE = 'packages/api-client/src';

  function runCli(shard: string): string[] {
    const result = spawnSync('node', [CLI, SCOPE, shard], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      timeout: 120_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.at(-1)).toMatch(/^test-shard-files: /);
    return lines.slice(0, -1);
  }

  function expectShardsCoverScope(): void {
    const first = runCli('1/2');
    const second = runCli('2/2');
    const all = collectRepoFiles(ROOT, new Set(['node_modules']))
      .filter((f) => f.startsWith(`${SCOPE}/`) && f.endsWith('.test.ts'))
      .sort();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(first.filter((f) => second.includes(f))).toEqual([]);
    // 比べるのは git が見るファイルだけ: vitest は `.gitignore` 済みの置き場（`src/generated/`）の一時ファイルも列挙するが、
    // `all` には出ない。並んで走る歯（`vitest-workspace-config.test.ts` の歯B）がそこへ probe を置いては消すので、
    // 列挙の瞬間に在るか無いかで食い違っていた（#5214）
    const scannable = new Set(all);
    expect([...first, ...second].filter((f) => scannable.has(f)).sort()).toEqual(all);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  }

  it('shard ごとの一覧は互いに重ならず、合わせると範囲の全テストファイルになる', () => {
    expectShardsCoverScope();
  }, 240_000);

  it('`.gitignore` 済みの置き場に一時の .test.ts が在っても、比べ方が食い違わない（#5214）', async () => {
    const generatedDir = path.join(ROOT, SCOPE, 'generated');
    const stray = path.join(generatedDir, 'test-shard-files-stray.test.ts');
    const createdDir = !existsSync(generatedDir);
    await mkdir(generatedDir, { recursive: true });
    await writeFile(stray, "import { it } from 'vitest';\n\nit('stray', () => undefined);\n");
    try {
      expectShardsCoverScope();
    } finally {
      await rm(stray, { force: true });
      // 作った側だけが、空なら消す: 並んで走る歯B が同じ置き場に probe を置いている途中でありうるため、中身ごとは消さない
      if (createdDir) await rmdir(generatedDir).catch(() => undefined);
    }
  }, 240_000);
});
