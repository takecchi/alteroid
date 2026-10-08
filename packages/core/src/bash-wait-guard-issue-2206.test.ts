import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

const T = ['ta', 'il'].join('');

describe('追従読みのガードは、引用符・エスケープで包んだフラグも弾く（#2206）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['二重引用符の -f', `${T} "-f" x`],
    ['単一引用符の -f', `${T} '-f' x`],
    ['二重引用符の --follow', `${T} "--follow" x`],
    ['フラグの文字だけを引用符で', `${T} -"f" x`],
    ['バックスラッシュでエスケープ', `${T} \\-f x`],
    ['二重引用符の -F', `${T} "-F" x`],
    ['ほかのフラグの後ろ', `${T} -n1 "-f" x`],
    ['ANSI-C 引用', `${T} $'-f' x`],
    ['コマンド名を割って引用', `"ta"il -f x`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('tail-f');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['引用符で包んだ -n', `${T} "-n" 1 x`],
    ['引用符で包んだファイル名', `${T} -n 5 "x -f.log"`],
    ['引用符の中の最後が -f のファイル名', `${T} -n 5 "x -f"`],
    ['単一引用符の中の最後が -f のファイル名', `${T} -n 5 'x -f'`],
    ['commit メッセージの中', `git commit -m "use ${T} -f x.log"`],
    ['Issue の本文の中', `gh issue comment 1 --body "run ${T} '-f' x.log"`],
    ['echo の引数', `echo '${T} "-f" x.log'`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('引用を外した写しの判定が、長い入力で2乗にならない（#2206）', () => {
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['引用符の繰り返し', (n) => `${T} ${'"-n" '.repeat(n)}x`, 8000],
    ['バックスラッシュの繰り返し', (n) => `${T} ${'\\-n '.repeat(n)}x`, 8000],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が線形に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }

  const K = 10_000;
  const makeFakeClock = () => {
    let now = 0;
    return { now: () => now, advance: (ms: number): void => void (now += ms) };
  };
  const makeLength = (n: number): number => `${T} ${'\\-n '.repeat(n)}x`.length;

  it('陰性対照: 2乗にした関数は落ちる', () => {
    const clock = makeFakeClock();
    const run = () =>
      expectNotSuperlinear((length: number) => clock.advance((length / K) ** 2), makeLength, {
        n: 8000,
        now: clock.now,
      });
    expect(run).toThrow(/2乗以上の後戻り/);
    expect(run).not.toThrow(/hardCapMs を超えた/);
  });

  it('陰性対照の対: 線形にした関数は投げない', () => {
    const clock = makeFakeClock();
    const result = expectNotSuperlinear((length: number) => clock.advance(length / K), makeLength, {
      n: 8000,
      now: clock.now,
    });
    expect(result.slope).toBeCloseTo(1, 2);
  });
});
