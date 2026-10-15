// 偽の `tini`（`--` の後ろを exec するだけ）と偽の `node`（環境を JSON で吐くだけ）を PATH の先頭に置いて、シムが node へ渡す環境を見る。
import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'alteroid-runner');

function run(env: Record<string, string>): { UV_THREADPOOL_SIZE: string | null } {
  const root = makeTempDirSync('alteroid-runner-shim-test-');
  writeFileSync(join(root, 'tini'), ['#!/bin/sh', 'shift', 'exec "$@"', ''].join('\n'));
  writeFileSync(
    join(root, 'node'),
    [
      '#!/bin/sh',
      '"$RUNNER_SHIM_TEST_REAL_NODE" -e \'console.log(JSON.stringify({ UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? null }))\'',
      '',
    ].join('\n'),
  );
  chmodSync(join(root, 'tini'), 0o755);
  chmodSync(join(root, 'node'), 0o755);
  const stdout = execFileSync(SCRIPT, [], {
    env: {
      PATH: `${root}:/usr/bin:/bin`,
      HOME: root,
      RUNNER_SHIM_TEST_REAL_NODE: process.execPath,
      ...env,
    },
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as { UV_THREADPOOL_SIZE: string | null };
}

describe('docker/alteroid-runner — libuv のスレッドの枠を広げる（#4890）', () => {
  it('UV_THREADPOOL_SIZE が無いとき（未設定・空）、16 を node の環境へ渡す', () => {
    expect(run({}).UV_THREADPOOL_SIZE).toBe('16');
    expect(run({ UV_THREADPOOL_SIZE: '' }).UV_THREADPOOL_SIZE).toBe('16');
  });

  it('人間が置いた値は上書きしない', () => {
    expect(run({ UV_THREADPOOL_SIZE: '8' }).UV_THREADPOOL_SIZE).toBe('8');
  });
});
