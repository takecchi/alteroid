import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

// 子の `PATH` は空の一時ディレクトリ1つだけにする: 親の `PATH` には `node_modules/.bin`（本物の vitest）が入っており、引き継ぐと ENOENT にならないため。
describe('scripts/test.mjs: vitest が見つからないときは exit 0 を返さない（#2661）', () => {
  const ROOT_DIR = join(import.meta.dirname, '..');
  const TEST_MJS_PATH = join(import.meta.dirname, 'test.mjs');

  async function runWithoutVitest(args: string[]) {
    const emptyBinDir = await makeTempDir('test-mjs-missing-vitest-');
    expect(existsSync(join(emptyBinDir, 'vitest'))).toBe(false);

    return spawnSync(process.execPath, [TEST_MJS_PATH, ...args], {
      cwd: ROOT_DIR,
      env: { PATH: emptyBinDir },
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15000,
    });
  }

  it.each([
    { label: '締め切り無し', args: [] },
    { label: '--deadline-seconds あり（detached で起こす経路）', args: ['--deadline-seconds=30'] },
  ])('$label: spawn の ENOENT を exit 1 で返し、理由を stderr に出す', async ({ args }) => {
    const result = await runWithoutVitest(args);
    const output = result.stdout + '\n---stderr---\n' + result.stderr;

    expect(result.signal, output).toBeNull();
    expect(result.status, output).toBe(1);
    expect(result.stderr).toContain('test-guard: ラッパ自身が例外で落ちた');
    expect(result.stderr).toContain('spawn vitest ENOENT');
  });
});
