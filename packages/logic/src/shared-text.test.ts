import { describe, expect, it } from 'vitest';

import { describeGrantedBy, splitList } from './shared-text.js';

describe('describeGrantedBy', () => {
  it('null は不明、operator は実行環境の持ち主、それ以外は id のまま', () => {
    expect(describeGrantedBy(null)).toBe('不明');
    expect(describeGrantedBy('operator')).toBe('実行環境の持ち主');
    expect(describeGrantedBy('acct-1')).toBe('acct-1');
  });
});

describe('splitList', () => {
  it('カンマで割り、前後の空白を落とし、空を除く', () => {
    expect(splitList(' a, b ,,c ,')).toEqual(['a', 'b', 'c']);
    expect(splitList('')).toEqual([]);
  });
});
