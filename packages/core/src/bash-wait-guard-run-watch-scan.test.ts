import { describe, expect, it } from 'vitest';

import { findGhRunWatch, GH_RUN_WATCH_RE, inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

function byRegex(command: string): { index: number; end: number } | null {
  const m = GH_RUN_WATCH_RE.exec(command);
  return m === null ? null : { index: m.index, end: m.index + m[0].length };
}

function prng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

const PIECES = [
  'gh',
  'gh',
  'run',
  'run',
  'watch',
  'watch',
  ' ',
  ' ',
  '  ',
  '\t',
  ';',
  '\n',
  '\r',
  '\r\n',
  '\u2028',
  '|',
  '||',
  '&',
  '&&',
  '1',
  'x',
  'ghx',
  'xgh',
  'rerun',
  'watcher',
  '-',
  '"',
  '\\',
];

function randomCommand(next: () => number): string {
  const length = 1 + Math.floor(next() * 24);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PIECES[Math.floor(next() * PIECES.length)] ?? '';
  return out;
}

describe('findGhRunWatch —— 元の GH_RUN_WATCH_RE と同じ一致（#2189）', () => {
  const handPicked = [
    'gh run watch 1 &',
    'gh run watch',
    'gh pr view 1; gh run watch 2 &',
    'gh pr view 1 && gh run watch 2',
    'gh gh gh run watch 1',
    'gh; run watch 1',
    'gh | run watch 1',
    'gh & run watch 1',
    'gh run\nwatch 1',
    'gh run \\\n  watch 1 &',
    'gh x\nrun watch 1',
    'gh x\r\nrun watch 1',
    'gh x\u2028run watch 1',
    'gh rerun watch',
    'gh run watcher',
    'ghx run watch',
    'gh run run watch',
    'echo gh; echo x; gh run watch 1',
    '',
  ];
  for (const command of handPicked) {
    it(`手で選んだ形: ${JSON.stringify(command)}`, () => {
      expect(findGhRunWatch(command)).toEqual(byRegex(command));
    });
  }

  it('乱数で作った 20000 通りの入力で、元の正規表現と一致する', () => {
    const next = prng(2_189);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const command = randomCommand(next);
      if (JSON.stringify(findGhRunWatch(command)) !== JSON.stringify(byRegex(command))) {
        mismatches.push(command);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe('背景の run watch の判定が、区切りの無い長い1行で2乗にならない（#2189）', () => {
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['gh の繰り返し', (n) => `${'gh '.repeat(n)}x`, 1000],
    ['gh run の繰り返し', (n) => `${'gh run '.repeat(n)}x`, 1000],
    ['gh pr merge 1 の繰り返し', (n) => `${'gh pr merge 1 '.repeat(n)}x`, 1000],
    [
      'gh と区切りの交互（run watch は最後だけ）',
      (n) => `${'gh x; '.repeat(n)}gh run watch 1`,
      1000,
    ],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が予算内に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }
});
