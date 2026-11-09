import { describe, expect, it } from 'vitest';

import { brief, ONE_SHOT_ALLOW_TTL_MS, WORKER_AGENT_NAME } from './runner.js';

// 期待の値は「切り出し前の runner.ts の出力から生成した値」を目で読んで確かめたもの（仕様を先に書いたものではない）。
// 生成に使った一時スクリプト: /tmp/mgr-3f15e37e-w128-tools/gen-values.mjs
// brief の補助面の文字と境界は `runner-brief.test.ts` も縛っている。ここは境界値と型の違いを足す。
// 意図的に `./runner.js` から import する: runner.ts 側の再 export が消えたときにここも落ちるため。

describe('brief() の値（切り出し前の出力から生成）', () => {
  it('文字列はそのまま、オブジェクトは JSON、undefined と関数は空文字、null と数値は JSON', () => {
    expect(brief('short')).toBe('short');
    expect(brief({ a: 1, b: ['x'] })).toBe('{"a":1,"b":["x"]}');
    expect(brief(undefined)).toBe('');
    expect(brief(() => 1)).toBe('');
    expect(brief(null)).toBe('null');
    expect(brief(12)).toBe('12');
  });

  it('既定の limit は 200: 200 文字は切らず、201 文字は 200 文字＋省略記号', () => {
    expect(brief('x'.repeat(200))).toBe('x'.repeat(200));
    expect(brief('x'.repeat(201))).toBe(`${'x'.repeat(200)}…`);
  });

  it('limit の境界: 10 は切らず、11 から切る', () => {
    expect(brief('x'.repeat(10), 10)).toBe('x'.repeat(10));
    expect(brief('x'.repeat(11), 10)).toBe(`${'x'.repeat(10)}…`);
    expect(brief('x'.repeat(20), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('絵文字が切り口をまたぐときは手前で切り、またがないときは絵文字ごと残す', () => {
    expect(brief(`${'x'.repeat(9)}\u{1F600}yy`, 10)).toBe(`${'x'.repeat(9)}…`);
    expect(brief(`${'x'.repeat(8)}\u{1F600}yy`, 10)).toBe(`${'x'.repeat(8)}\u{1F600}…`);
  });
});

describe('定数', () => {
  it('ONE_SHOT_ALLOW_TTL_MS は 10 分', () => {
    expect(ONE_SHOT_ALLOW_TTL_MS).toBe(10 * 60 * 1000);
    expect(ONE_SHOT_ALLOW_TTL_MS).toBe(600000);
  });

  it('WORKER_AGENT_NAME は worker', () => {
    expect(WORKER_AGENT_NAME).toBe('worker');
  });
});
