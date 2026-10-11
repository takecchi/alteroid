import { describe, expect, it } from 'vitest';

import { delegationSubreaperOf } from './index.js';

const childUser = { uid: 1000, gid: 1000 };

describe('delegationSubreaperOf（#4494。委譲の CLI の引き取り手を PATH から探す）', () => {
  it('PATH の前から順に探し、最初に実行できる tini の絶対パスを返す', () => {
    const seen: string[] = [];
    const found = delegationSubreaperOf(
      { PATH: '/usr/local/bin:/usr/bin:/bin' },
      childUser,
      (path) => {
        seen.push(path);
        return path === '/usr/bin/tini' || path === '/bin/tini';
      },
    );
    expect(found).toBe('/usr/bin/tini');
    expect(seen).toEqual(['/usr/local/bin/tini', '/usr/bin/tini']);
  });

  it('相対パスの PATH の要素は見ない: 作業ディレクトリ次第で別のものを拾うため', () => {
    const seen: string[] = [];
    const found = delegationSubreaperOf({ PATH: 'bin:.:/usr/bin' }, childUser, (path) => {
      seen.push(path);
      return true;
    });
    expect(found).toBe('/usr/bin/tini');
    expect(seen).toEqual(['/usr/bin/tini']);
  });

  it('見つからなければ undefined（CLI を直に起こす）', () => {
    expect(
      delegationSubreaperOf({ PATH: '/usr/bin:/bin' }, childUser, () => false),
    ).toBeUndefined();
    expect(delegationSubreaperOf({}, childUser, () => true)).toBeUndefined();
  });

  it('子の UID へ降ろさない構成では探さない: 委譲を自前で起こす経路が無いため', () => {
    expect(delegationSubreaperOf({ PATH: '/usr/bin' }, undefined, () => true)).toBeUndefined();
  });
});
