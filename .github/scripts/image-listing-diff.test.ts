// 突き合わせに除外を持たせない: 別々のビルドの差は除外ではなく同一ビルドにして直す（`docker-bake.hcl`）ため。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../vitest.tmpdir.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'image-listing-diff.sh');
const CI_YML = join(HERE, '..', 'workflows', 'ci.yml');
// 親の process.env を丸ごと継がせない（#1971）。sh と diff を解決する PATH だけ渡す。
const CHILD_ENV = { PATH: process.env['PATH'] ?? '' };

const BASE = [
  '-rw-r--r-- 0/0 119230   var/log/dpkg.log',
  '-rw-r--r-- 1000/1000 186607   app/packages/core/dist/chunk-YYHANAXB.js',
  '-rw-r--r-- 1000/1000 254800   app/packages/core/dist/chunk-YYHANAXB.js.map',
  '-rw-r--r-- 0/0 7860   var/log/apt/eipp.log.xz',
  'drwxrwxr-x 0/0 0   var/cache/debconf/tmp.ci/',
  'drwxr-xr-x 0/0 0   root/.codex/tmp/arg0/codex-arg0T8g75f/',
  '-rwxr-xr-x 0/0 1024   usr/local/bin/alteroidd',
];

function run(runtime: string[], final: string[]) {
  const dir = makeTempDirSync('image-listing-diff-');
  const r = join(dir, 'runtime.list');
  const f = join(dir, 'final.list');
  writeFileSync(r, `${[...runtime].sort().join('\n')}\n`);
  writeFileSync(f, `${[...final].sort().join('\n')}\n`);
  return spawnSync('sh', [SCRIPT, r, f], { encoding: 'utf8', env: CHILD_ENV });
}

describe('image-listing-diff.sh', () => {
  it('同一の列挙は緑', () => {
    expect(run(BASE, BASE).status).toBe(0);
  });

  it('runtime にあるファイルが final に無ければ赤（本物の欠落）', () => {
    const r = run(
      BASE,
      BASE.filter((l) => !l.endsWith('usr/local/bin/alteroidd')),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ファイル系で違う');
  });

  it('同名のファイルのサイズ（中身）が違えば赤', () => {
    const r = run(
      BASE,
      BASE.map((l) =>
        l.replace('1024   usr/local/bin/alteroidd', '1025   usr/local/bin/alteroidd'),
      ),
    );
    expect(r.status).toBe(1);
  });

  it('final にだけあるファイルも赤', () => {
    expect(run(BASE, [...BASE, '-rw-r--r-- 0/0 1   etc/extra']).status).toBe(1);
  });

  it('別ビルドで出た差（今回の形: 一時ディレクトリ名・chunk 名・ログのサイズ・tmp の権限）は赤 = 比較側では隠していない', () => {
    const other = BASE.map((l) =>
      l
        .replace('codex-arg0T8g75f', 'codex-arg04TSNbc')
        .replaceAll('chunk-YYHANAXB', 'chunk-4THVW6JX')
        .replace('7860', '7868')
        .replace('drwxrwxr-x', 'drwxr-xr-x'),
    );
    expect(run(BASE, other).status).toBe(1);
  });

  it('引数が足りなければ 2', () => {
    expect(spawnSync('sh', [SCRIPT], { encoding: 'utf8', env: CHILD_ENV }).status).toBe(2);
  });
});

describe('ci.yml の image job', () => {
  const yml = readFileSync(CI_YML, 'utf8');
  const bake = readFileSync(join(HERE, '..', '..', 'docker-bake.hcl'), 'utf8');

  it('final と runtime は 1 回の bake で焼き、別々の build-push-action に戻していない', () => {
    expect(yml).toContain('docker/bake-action@');
    expect(yml).not.toMatch(/^\s+target: runtime$/m);
    expect(bake).toMatch(/tags\s*=\s*\["alteroid:ci-runtime"\]/);
    expect(bake).toMatch(/tags\s*=\s*\["alteroid:ci"\]/);
  });

  it('突き合わせは image-listing-diff.sh を通る（diff を直書きして除外を足さない）', () => {
    expect(yml).toContain(
      'sh .github/scripts/image-listing-diff.sh /tmp/runtime.list /tmp/final.list',
    );
  });
});
