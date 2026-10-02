import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

/**
 * `scripts/test.mjs` が vitest を起こせなかったとき（`spawn vitest ENOENT`）に、
 * **exit 0 を返さない**ことの陰性対照（#2661）。
 *
 * テストの入口が「1本も走らなかった」を「通った」と同じ 0 で返すと、CI や手元の
 * 検証がテストを回さずに緑になる。`test.mjs` は末尾の `main().catch(...)` で
 * 例外を exit 1 に落とす作りだが、その配線を測る歯がこれまで無かった——
 * `catch` を消す・`process.exitCode = 0` に変える変異が、どのテストにも
 * 捕まらずに通っていた。
 *
 * ## vitest を「見つからない」状態にする方法
 *
 * 子の `PATH` を、**空の一時ディレクトリ1つだけ**にする。`pnpm test` 経由で
 * このテストが走るとき、親の `PATH` には `node_modules/.bin`（本物の vitest）が
 * 入っているので、親の `PATH` を引き継ぐと ENOENT にならない。node 自身は
 * `process.execPath` を絶対パスで起こすので `PATH` に要らない。
 *
 * 締め切りあり（`detached: true` で起こす経路）と無しは `runVitest` の中で
 * spawn の形が分かれるので、両方を測る。
 */
describe('scripts/test.mjs: vitest が見つからないときは exit 0 を返さない（#2661）', () => {
  const ROOT_DIR = join(import.meta.dirname, '..');
  const TEST_MJS_PATH = join(import.meta.dirname, 'test.mjs');

  async function runWithoutVitest(args: string[]) {
    const emptyBinDir = await makeTempDir('test-mjs-missing-vitest-');
    // 前提: この PATH の中に vitest は無い（在れば測定が成り立たない）。
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

    // spawnSync 自身の timeout で殺された回（status が null）を、ここで別の失敗として
    // 弾く——null は 0 ではないが、それは「ラッパが非0を返した」の証拠にならない。
    expect(result.signal, output).toBeNull();
    expect(result.status, output).toBe(1);
    // 落ちた理由が「vitest が見つからない」であること（import の失敗など、別の理由で
    // 非0になった回をこの歯の合格に数えない）。
    expect(result.stderr).toContain('test-guard: ラッパ自身が例外で落ちた');
    expect(result.stderr).toContain('spawn vitest ENOENT');
  });
});
