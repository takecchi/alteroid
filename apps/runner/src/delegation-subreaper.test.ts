import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { delegationSubreaperOf } from './index.js';

const childUser = { uid: 1000, gid: 1000 };

// 本物のファイルを一時ディレクトリに置いて `PATH` で指す（実行ビットの有無まで本番の判定を通す）
function binDir(options: { tini?: 'executable' | 'plain' | 'directory' } = {}): string {
  const dir = makeTempDirSync('alteroid-tini-');
  const path = join(dir, 'tini');
  if (options.tini === 'directory') mkdirSync(path);
  else if (options.tini !== undefined) {
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, options.tini === 'executable' ? 0o755 : 0o644);
  }
  return dir;
}

describe('delegationSubreaperOf（#4494。委譲の CLI の引き取り手を PATH から探す）', () => {
  it('PATH の前から順に探し、最初に実行できる tini の絶対パスを返す', () => {
    const empty = binDir();
    const first = binDir({ tini: 'executable' });
    const second = binDir({ tini: 'executable' });
    const found = delegationSubreaperOf(
      { PATH: [empty, first, second].join(delimiter) },
      childUser,
    );
    expect(found).toBe(join(first, 'tini'));
  });

  it('実行ビットの無い tini と、tini という名前のディレクトリは飛ばして、次の候補を見る', () => {
    const plain = binDir({ tini: 'plain' });
    const directory = binDir({ tini: 'directory' });
    const good = binDir({ tini: 'executable' });
    const found = delegationSubreaperOf(
      { PATH: [plain, directory, good].join(delimiter) },
      childUser,
    );
    expect(found).toBe(join(good, 'tini'));
  });

  it('相対パスの PATH の要素は見ない: 作業ディレクトリ次第で別のものを拾うため', () => {
    const good = binDir({ tini: 'executable' });
    const viaRelative = relative(process.cwd(), good);
    expect(delegationSubreaperOf({ PATH: viaRelative }, childUser)).toBeUndefined();
    expect(
      delegationSubreaperOf({ PATH: ['bin', '.', viaRelative, good].join(delimiter) }, childUser),
    ).toBe(join(good, 'tini'));
  });

  it('見つからなければ undefined（CLI を直に起こす）', () => {
    expect(delegationSubreaperOf({ PATH: binDir() }, childUser)).toBeUndefined();
    expect(delegationSubreaperOf({}, childUser)).toBeUndefined();
  });

  it('子の UID へ降ろさない構成では探さない: 委譲を自前で起こす経路が無いため', () => {
    const good = binDir({ tini: 'executable' });
    expect(delegationSubreaperOf({ PATH: good }, undefined)).toBeUndefined();
  });
});
