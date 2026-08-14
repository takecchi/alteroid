import { describe, expect, it } from 'vitest';

import { createRecentMap } from './recent.js';

describe('上限つきの帳面', () => {
  it('上限までは覚えていて、そのまま引ける', () => {
    const map = createRecentMap<string>({ limit: 3 });
    map.set('a', '1');
    map.set('b', '2');
    map.set('c', '3');
    expect(map.get('a')).toBe('1');
    expect(map.has('c')).toBe(true);
    expect(map.size).toBe(3);
  });

  it('溢れたら古い側から忘れ、忘れたことを必ず言う（黙って落とさない）', () => {
    // 黙って落とすと、忘れた id の再送が「新しい確認」として表に出たときに、
    // なぜ二度届いたのかを誰も辿れない。
    const forgotten: string[][] = [];
    const map = createRecentMap<string>({ limit: 2, onForget: (ids) => forgotten.push(ids) });
    map.set('a', '1');
    map.set('b', '2');
    expect(forgotten).toEqual([]);

    map.set('c', '3');
    expect(forgotten).toEqual([['a']]);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
    expect(map.size).toBe(2);
  });

  it('入れ直したものは新しい側へ寄る（触れたものから先に忘れない）', () => {
    const map = createRecentMap<string>({ limit: 2 });
    map.set('a', '1');
    map.set('b', '2');
    map.set('a', '1-again');
    map.set('c', '3');
    expect(map.has('a')).toBe(true);
    expect(map.get('a')).toBe('1-again');
    expect(map.has('b')).toBe(false);
  });

  it('上限が0以下なら作らせない（覚えないのに覚えたつもりになる）', () => {
    expect(() => createRecentMap({ limit: 0 })).toThrow();
    expect(() => createRecentMap({ limit: 1.5 })).toThrow();
  });
});
