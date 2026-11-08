import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

const SCRIPT_PATH = join(import.meta.dirname, 'check-typecheck-prereqs.mjs');

function put(root: string, rel: string, content: string) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function makeRoot(options: { canon: boolean; dist: boolean }) {
  const root = await makeTempDir('check-typecheck-prereqs-');
  put(
    root,
    'packages/core/package.json',
    JSON.stringify({
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './usage': { types: './dist/usage-format.d.ts', import: './dist/usage-format.js' },
      },
    }),
  );
  if (options.canon) put(root, 'packages/core/src/generated/canon.ts', '');
  if (options.dist) {
    put(root, 'packages/core/dist/index.d.ts', '');
    put(root, 'packages/core/dist/usage-format.d.ts', '');
  }
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH, root], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: process.env.PATH ?? '' },
  });
}

describe('check-typecheck-prereqs: typecheck の前提の生成物（#6613）', () => {
  it('生成物が両方在れば何も言わず exit 0', async () => {
    const result = run(await makeRoot({ canon: true, dist: true }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('どちらも無ければ exit 1 で、build の案内と無いファイルを出す', async () => {
    const result = run(await makeRoot({ canon: false, dist: false }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('先に `pnpm -F @alteroid/core build` を実行してください');
    expect(result.stderr).toContain('packages/core/src/generated/canon.ts');
    expect(result.stderr).toContain('packages/core/dist/usage-format.d.ts');
  });

  it('canon.ts だけ無くても落ちる', async () => {
    const result = run(await makeRoot({ canon: false, dist: true }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/core/src/generated/canon.ts');
    expect(result.stderr).not.toContain('dist/');
  });

  it('dist だけ無くても落ちる', async () => {
    const result = run(await makeRoot({ canon: true, dist: false }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/core/dist/index.d.ts');
    expect(result.stderr).not.toContain('canon.ts');
  });
});
