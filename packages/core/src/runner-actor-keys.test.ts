import { describe, expect, it } from 'vitest';

import { actorOf, digestOf, workerActorOf } from './runner-actor-keys.js';
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

  it('limit はコードポイントで数える: 絵文字は 1 つと数え、切り口にかかっても残す（孤立サロゲートは出ない）', () => {
    expect(brief(`${'x'.repeat(9)}\u{1F600}yy`, 10)).toBe(`${'x'.repeat(9)}\u{1F600}…`);
    expect(brief(`${'x'.repeat(8)}\u{1F600}yy`, 10)).toBe(`${'x'.repeat(8)}\u{1F600}y…`);
  });
});

// 以下の値は移す前の runner.ts の本文を gen-values.mjs で評価して得たもの（移した後の関数に当てて同じになることを見る）
describe('digestOf()', () => {
  it('sha256 の先頭 16 桁の hex（空・1 文字・日本語・長い文字列）', () => {
    expect(digestOf('')).toBe('e3b0c44298fc1c14');
    expect(digestOf('a')).toBe('ca978112ca1bbdca');
    expect(digestOf('あいうえお')).toBe('fdb481ea956fdb65');
    expect(digestOf('abc'.repeat(100))).toBe('d9f5aeb06abebb3b');
    expect(digestOf('あ'.repeat(500))).toBe('92cd8e86e659d627');
  });

  it('16 桁の hex で、同じ入力は同じ値・違う入力は違う値', () => {
    for (const v of ['', 'x', 'あ'.repeat(50)]) {
      expect(digestOf(v)).toMatch(/^[0-9a-f]{16}$/);
      expect(digestOf(v)).toBe(digestOf(v));
    }
    expect(digestOf('x')).not.toBe(digestOf('y'));
  });
});

describe('workerActorOf() / actorOf()', () => {
  it('workerActorOf: agentType が無いときは WORKER_AGENT_NAME', () => {
    expect(workerActorOf('m1', undefined)).toBe('worker:m1:worker');
    expect(workerActorOf('m1', undefined)).toBe(`worker:m1:${WORKER_AGENT_NAME}`);
    expect(workerActorOf('m1', 'coder')).toBe('worker:m1:coder');
    expect(workerActorOf('', undefined)).toBe('worker::worker');
  });

  it('actorOf: agentId が無ければ manager（agentType があっても）、あれば worker（agentType の有無で名前が変わる）', () => {
    expect(actorOf('m1', {})).toBe('manager:m1');
    expect(actorOf('m1', { agentType: 'coder' })).toBe('manager:m1');
    expect(actorOf('m1', { agentId: 'a1' })).toBe('worker:m1:worker');
    expect(actorOf('m1', { agentId: 'a1', agentType: 'coder' })).toBe('worker:m1:coder');
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
