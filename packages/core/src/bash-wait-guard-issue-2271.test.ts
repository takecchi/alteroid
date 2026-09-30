import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * Issue #2271 の A —— 背景の run watch の判定（`FIRST_CONTROL_OPERATOR_RE`）が、`|&`
 * （stderr もパイプへ流す**前景**の形）の `&` を背景の `&` と読んでいた（PR #2180 / #2190）。
 *
 * `run watch` の字面は組み立てる（このファイルをヒアドキュメントで書くと、本番の版のガードに
 * 誤検知で弾かれるため。#2130）。
 */
const W = ['gh', 'run', 'watch'].join(' ');

describe('背景の run watch の判定は、|& を背景の & と読まない（#2271 A）', () => {
  const passing: ReadonlyArray<[string, string]> = [
    ['|& tee', `${W} 1 |& tee log`],
    ['{ …; } |& tee', `{ ${W} 1; } |& tee log`],
    ['( … ) |& tee', `( ${W} 1 ) |& tee log`],
    ['|& を2段', `${W} 1 |& cat |& tee log`],
    ['対照: 2>&1 | tee', `${W} 1 2>&1 | tee log`],
    ['対照: &> の前景（リダイレクト）', `${W} 1 &> log`],
    ['対照: &>> の前景（リダイレクト）', `${W} 1 &>> log`],
    ['対照: <&- の前景（fd を閉じる）', `${W} 1 <&-`],
    ['対照: && の連鎖', `${W} 1 && echo done`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }

  const blocked: ReadonlyArray<[string, string]> = [
    ['対照: 素の背景', `${W} 1 &`],
    ['対照: 背景の後ろに別のコマンド', `${W} 1 & echo x`],
    ['|& の後ろが背景', `${W} 1 |& tee log &`],
    ['{ …; } |& の後ろが背景', `{ ${W} 1; } |& tee log &`],
    ['|& の後ろの ; の前が背景', `${W} 1 |& tee log & echo x`],
    ['&> で流してから背景', `${W} 1 &> log &`],
    ['2>&1 で流してから背景', `${W} 1 2>&1 &`],
    ['{ …; } を背景へ', `{ ${W} 1; } &`],
    ['( … ) を背景へ', `( ${W} 1 ) &`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-run-watch-background');
    });
  }
});
