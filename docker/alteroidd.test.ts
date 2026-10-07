// 本物の `node` にも `setpriv` にも触れず、PATH の先頭に偽の `node` を置く: `entry` は本番のコンテナにしか無いパスだが、偽の `node` は引数として受け取るだけなので存在しなくても実行できる。
// `setpriv` の分岐（root で起きたとき）そのものは実行しない: `--init-groups` は特権操作を要求し、テスト実行環境は root ではないため。`NODE_OPTIONS` の分岐が `setpriv` の枝より前に在ることを静的に固定して補う。
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'alteroidd');
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');

type Result = { exitCode: number; stdout: string; stderr: string };

function mktemp(): string {
  return makeTempDirSync('alteroidd-test-');
}

function setupFakeNode(root: string): void {
  const bin = join(root, 'node');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      // 実体（`ALTEROIDD_TEST_REAL_NODE`）を明示的に使う: ここでの `node` は PATH 上で自分自身を指してしまうため。
      '"$ALTEROIDD_TEST_REAL_NODE" -e \'',
      'console.log(JSON.stringify({',
      '  args: process.argv.slice(1),',
      '  NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,',
      '}));',
      '\' -- "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
}

function setupHeapProbeNode(root: string): void {
  const bin = join(root, 'node');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      '"$ALTEROIDD_TEST_REAL_NODE" -e \'',
      'console.log(require("v8").getHeapStatistics().heap_size_limit/1024/1024);',
      "'",
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
}

function run(
  args: string[],
  env: Record<string, string> = {},
  node: 'echo' | 'heap' = 'echo',
): Result {
  const root = mktemp();
  if (node === 'echo') setupFakeNode(root);
  else setupHeapProbeNode(root);

  const fullEnv: Record<string, string> = {
    PATH: `${root}:/usr/bin:/bin`,
    HOME: root,
    // 偽の `node` の中から本物の node を呼べるようにする: PATH 経由だと自分自身＝偽の node を再帰的に呼んでしまうため。
    ALTEROIDD_TEST_REAL_NODE: process.execPath,
    ...env,
  };

  try {
    const stdout = execFileSync(SCRIPT, args, { env: fullEnv, encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString('utf8') ?? '',
      stderr: e.stderr?.toString('utf8') ?? '',
    };
  }
}

describe('docker/alteroidd — V8 ヒープ上限の既定（応急処置。#1283 系列）', () => {
  it('NODE_OPTIONS が無いとき、既定の --max-old-space-size=12288 を足す', () => {
    const result = run(['--foo']);
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.args).toEqual(['/app/apps/daemon/dist/index.js', '--foo']);
    expect(out.NODE_OPTIONS).toContain('--max-old-space-size=12288');
  });

  it('外から --max-old-space-size が来ていれば、値を変えず1文字も触らない', () => {
    const result = run(['--foo'], { NODE_OPTIONS: '--max-old-space-size=2048' });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=2048');
  });

  it('他のフラグと共存する（既存のフラグを消さない）', () => {
    const result = run(['--foo'], { NODE_OPTIONS: '--trace-warnings' });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.NODE_OPTIONS).toContain('--trace-warnings');
    expect(out.NODE_OPTIONS).toContain('--max-old-space-size=12288');
  });

  // 既定（4,144 MB 相当）との比較は入れない: 素の V8 の既定値は器の実メモリで変わり、固定すると器の違いで壊れる歯になるため。
  it('⭐ ヒープ上限が実際に変わる（本物の V8 で実測）', () => {
    const withoutExternal = run([], {}, 'heap');
    expect(withoutExternal.exitCode).toBe(0);
    const bytesWithoutExternal = Number(withoutExternal.stdout.trim());
    // 12288 ちょうどではなく近傍であることだけを見る: V8 が固定の overhead を足すため。
    expect(bytesWithoutExternal).toBeGreaterThanOrEqual(12288);
    expect(bytesWithoutExternal).toBeLessThan(12288 + 500);

    const withExternal = run([], { NODE_OPTIONS: '--max-old-space-size=2048' }, 'heap');
    expect(withExternal.exitCode).toBe(0);
    const bytesWithExternal = Number(withExternal.stdout.trim());
    expect(bytesWithExternal).toBeGreaterThanOrEqual(2048);
    expect(bytesWithExternal).toBeLessThan(2048 + 500);
    expect(bytesWithExternal).toBeLessThan(12288);
  });

  it('NODE_OPTIONS の分岐は id -u の判定より前に置いてある（root・非 root どちらの枝にも効く）', () => {
    const caseIndex = SCRIPT_SOURCE.indexOf('max-old-space-size=12288');
    const idCheckIndex = SCRIPT_SOURCE.indexOf(`if [ "$(id -u)" = '0' ]`);
    expect(caseIndex).toBeGreaterThan(-1);
    expect(idCheckIndex).toBeGreaterThan(-1);
    expect(caseIndex).toBeLessThan(idCheckIndex);
  });
});
