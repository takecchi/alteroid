import { describe, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

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
