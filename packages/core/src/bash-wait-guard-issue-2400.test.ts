import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2400 —— `isBackgroundedGhRunWatch` が最初の `gh run watch` しか見ず、前景の run watch の
 * 後ろに続く背景の run watch（`coproc` と `{ …; } &` の判定も同じ）を見落としていた。
 *
 * `run watch` の字面は組み立てる（このファイルをヒアドキュメントで書くと、本番の版のガードに
 * 誤検知で弾かれるため。#2130）。
 */
const W = ['gh', 'run', 'watch'].join(' ');

describe('2件目以降の run watch も、背景かを見る（#2400）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['対照: 1件の背景', `${W} 2 &`],
    ['前景の後ろに背景', `${W} 1 --exit-status; ${W} 2 &`],
    ['前景を && で繋いで背景', `${W} 1 && ${W} 2 &`],
    ['前景を | で繋いで背景', `${W} 1 | cat; ${W} 2 &`],
    ['改行の後ろの背景', `${W} 1\n${W} 2 &`],
    ['3件目が背景', `${W} 1; ${W} 2; ${W} 3 &`],
    ['2件目が coproc', `${W} 1; coproc ${W} 2`],
    ['2件目が { …; } &', `${W} 1; { ${W} 2; } &`],
    ['2件目が ( … ) &', `${W} 1; ( ${W} 2 ) &`],
    ['2件目が setsid', `${W} 1; setsid ${W} 2`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-run-watch-background');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['全部前景', `${W} 1; ${W} 2`],
    ['全部前景（&& と改行）', `${W} 1 && ${W} 2\n${W} 3`],
    ['前景の後ろに別のコマンドの背景', `${W} 1; ${W} 2; sleep 1 &`],
    ['2件目が |& の前景', `${W} 1; ${W} 2 |& tee log`],
    ['2件目が 2>&1 の前景', `${W} 1; ${W} 2 2>&1`],
    ['2件目が timeout の前景', `${W} 1; timeout 60 ${W} 2`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('run watch が何件並んでも2乗にならない（#2400）', () => {
  it('区切りごとに前景の run watch（全部前景）', () => {
    const makeInput = (n: number) => `${`${W} 1; `.repeat(n)}echo done`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 300 });
  });
  it('| で繋いだ run watch（制御演算子が無い）', () => {
    const makeInput = (n: number) => `${`${W} 1 | `.repeat(n)}cat`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 300 });
  });
  it('波括弧のグループが並ぶ（背景ではない）', () => {
    const makeInput = (n: number) => `${`{ ${W} 1; }; `.repeat(n)}echo done`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 300 });
  });
  it('閉じていない { の後ろに run watch が並ぶ', () => {
    const makeInput = (n: number) => `{ ${`${W} 1; `.repeat(n)}echo done`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 300 });
  });
  it('区切りの無い1行の run watch', () => {
    const makeInput = (n: number) => `${`${W} `.repeat(n)}1`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 300 });
  });
});
