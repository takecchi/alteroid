import { describe, expect, it } from 'vitest';

import { findGhRunWatch, GH_RUN_WATCH_RE, inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * #2189 —— 背景の `gh run watch` の判定を、正規表現（`GH_RUN_WATCH_RE`）の `exec` から
 * `findGhRunWatch`（区切りの中で最初の `gh` だけを試す線形の走査）に替えた。**一致の位置と末尾を
 * 1文字も変えていないこと**を、元の正規表現を託宣として突き合わせて確かめる（#2181 のループと同じ形）。
 *
 * 替えた理由: 区切りの無い1行に `gh` が並ぶと、正規表現は2乗になる。#2189 で行の継続を
 * 取り除いた写しにも判定をかけるようになり、`\` + 改行で折り返した形もこの1行になった
 * （`bash-wait-guard-issue-2179.test.ts` の「行の継続の繰り返し」が比 15 で落ちた）。
 */
function byRegex(command: string): { index: number; end: number } | null {
  const m = GH_RUN_WATCH_RE.exec(command);
  return m === null ? null : { index: m.index, end: m.index + m[0].length };
}

/** 再現できる乱数（xorshift32）。種を固定して、落ちたら同じ入力を作り直せるようにする。 */
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
  // 直す前（findGhRunWatch を入れる前、2026-09-30 実測）は `gh ` の 4000 回で比 17。
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
      // factor: 16（n..16n の5点・傾き4つ）。この歯は線形でも区間の傾きが揺れ、既定の factor=8（傾き3つ）では
      // 通ったときの傾きの中央値が 3 回の実測で最大 1.30〜1.41 と閾値 1.5 に寄った（#3017。2206 と同じ扱い）。
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, {
        n,
        factor: 16,
      });
    });
  }
});
