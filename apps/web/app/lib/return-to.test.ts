import { describe, expect, it } from 'vitest';

import { returnPathFrom } from './return-to';

describe('returnPathFrom', () => {
  it('同じオリジンのアプリ内パスはそのまま戻り先にする', () => {
    expect(returnPathFrom({ from: '/schedule' })).toBe('/schedule');
    expect(returnPathFrom({ from: '/memory/foo?a=1#x' })).toBe('/memory/foo?a=1#x');
    expect(returnPathFrom({ from: '/loginx' })).toBe('/loginx');
  });

  it.each([
    ['無し', undefined],
    ['null', null],
    ['文字列でない', { from: 42 }],
    ['空', { from: '' }],
    ['相対パス', { from: 'memory' }],
    ['絶対 URL', { from: 'https://evil.example/' }],
    ['プロトコル相対', { from: '//evil.example/' }],
    ['バックスラッシュ', { from: '/\\evil.example/' }],
  ])('%s はホームへ倒す', (_name, state) => {
    expect(returnPathFrom(state)).toBe('/');
  });

  it.each(['/login', '/login?x=1', '/login#x', '/login/'])(
    '%s（ログイン画面自体）はホームへ倒す',
    (from) => {
      expect(returnPathFrom({ from })).toBe('/');
    },
  );
});
