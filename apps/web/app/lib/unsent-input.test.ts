import { describe, expect, it } from 'vitest';

import { unsentInput } from './unsent-input';

describe('unsentInput', () => {
  it('送った値と同じなら空にする', () => {
    expect(unsentInput('abc', 'abc')).toBe('');
  });
  it('送った値の続きに打ち足していれば、打ち足した分だけ残す', () => {
    expect(unsentInput('abc\n次', 'abc')).toBe('次');
    expect(unsentInput('abc 次', 'abc')).toBe('次');
  });
  it('途中を書き換えていれば、そのまま残す', () => {
    expect(unsentInput('xbc', 'abc')).toBe('xbc');
  });
  it('入力が空に戻されていれば空のまま', () => {
    expect(unsentInput('', 'abc')).toBe('');
  });
});
