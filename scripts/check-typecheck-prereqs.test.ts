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

async function makeRoot(options: { canon: boolean; coreDist: boolean; storageDist: boolean }) {
  const root = await makeTempDir('check-typecheck-prereqs-');
  put(
    root,
    'packages/core/package.json',
    JSON.stringify({
      name: '@alteroid/core',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './usage': { types: './dist/usage-format.d.ts', import: './dist/usage-format.js' },
      },
    }),
  );
  put(
    root,
    'packages/storage-fs/package.json',
    JSON.stringify({
      name: '@alteroid/storage-fs',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }),
  );
  // exports を持たない（dist を指さない）workspace は前提に数えない
  put(root, 'apps/web/package.json', JSON.stringify({ name: '@alteroid/web' }));
  if (options.canon) put(root, 'packages/core/src/generated/canon.ts', '');
  if (options.coreDist) {
    put(root, 'packages/core/dist/index.d.ts', '');
    put(root, 'packages/core/dist/usage-format.d.ts', '');
  }
  if (options.storageDist) put(root, 'packages/storage-fs/dist/index.d.ts', '');
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
  it('生成物が全て在れば何も言わず exit 0', async () => {
    const result = run(await makeRoot({ canon: true, coreDist: true, storageDist: true }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('何も無ければ exit 1 で、build の案内と無いファイルを出す', async () => {
    const result = run(await makeRoot({ canon: false, coreDist: false, storageDist: false }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('先に `pnpm -F @alteroid/core -F @alteroid/storage-fs build`');
    expect(result.stderr).toContain('packages/core/src/generated/canon.ts');
    expect(result.stderr).toContain('packages/core/dist/usage-format.d.ts');
    expect(result.stderr).toContain('packages/storage-fs/dist/index.d.ts');
  });

  it('canon.ts だけ無いときは core の build を案内する', async () => {
    const result = run(await makeRoot({ canon: false, coreDist: true, storageDist: true }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('先に `pnpm -F @alteroid/core build` を実行してください');
    expect(result.stderr).toContain('packages/core/src/generated/canon.ts');
    expect(result.stderr).not.toContain('dist/');
  });

  it('core の dist だけ無くても落ちる', async () => {
    const result = run(await makeRoot({ canon: true, coreDist: false, storageDist: true }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('先に `pnpm -F @alteroid/core build` を実行してください');
    expect(result.stderr).toContain('packages/core/dist/index.d.ts');
    expect(result.stderr).not.toContain('canon.ts');
  });

  it('storage-fs の dist だけ無くても落ちる（core だけ build した状態）', async () => {
    const result = run(await makeRoot({ canon: true, coreDist: true, storageDist: false }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('先に `pnpm -F @alteroid/storage-fs build` を実行してください');
    expect(result.stderr).toContain('packages/storage-fs/dist/index.d.ts');
  });
});
