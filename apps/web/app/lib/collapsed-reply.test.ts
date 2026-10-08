import { describe, expect, it } from 'vitest';

import { applyCollapsedReplies } from './collapsed-reply';

const line = (text: string, replyGroup = 'g1', role = 'clone') => ({ role, text, replyGroup });

describe('切り詰めた返信の受信行への反映（#4142）', () => {
  it('1行が from と一致すれば to に置き換える', () => {
    const lines = [line('人間', 'g1', 'human'), line('abc')];
    expect(applyCollapsedReplies(lines, 'g1', [{ from: 'abc', to: 'a' }])).toEqual([
      lines[0],
      line('a'),
    ]);
  });

  it('連続した複数行の連結が from と一致すれば、最初の行へ寄せて残りを消す', () => {
    const lines = [line('ab'), line('cd'), line('ef')];
    expect(applyCollapsedReplies(lines, 'g1', [{ from: 'abcd', to: 'X' }])).toEqual([
      line('X'),
      line('ef'),
    ]);
  });

  it('一致しない・別のターンの行は触らない', () => {
    const lines = [line('abc', 'g2')];
    expect(applyCollapsedReplies(lines, 'g1', [{ from: 'abc', to: 'a' }])).toEqual(lines);
    expect(applyCollapsedReplies([line('abc')], 'g1', [{ from: 'zzz', to: 'a' }])).toEqual([
      line('abc'),
    ]);
  });
});
