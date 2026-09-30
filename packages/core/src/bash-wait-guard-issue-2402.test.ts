import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2402 —— `FLOCK_OPTION_SRC` が、値を取るオプションとして、ちょうど2文字の `-w` / `-E` しか
 * 認めなかった。短いオプションを束ねて最後に `w` / `E` を置いた形（`-nw 5`）を値の無いオプションと
 * 読み、`5` をロックファイル、本来のロックファイルをコマンドと読み違えて、`gh pr merge` の門を
 * 素通りさせていた。
 */
const MERGE = 'gh pr merge 1 --squash --body x --match-head-commit a -d';

describe('flock の束ねた値付きオプション（#2402）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['対照: -n', `flock -n l ${MERGE}`],
    ['対照: -w 5', `flock -w 5 l ${MERGE}`],
    ['-nw 5', `flock -nw 5 l ${MERGE}`],
    ['-xnw 5', `flock -xnw 5 l ${MERGE}`],
    ['-nE 3', `flock -nE 3 l ${MERGE}`],
    ['-nw 5 の後ろにもう1つ', `flock -nw 5 -x l ${MERGE}`],
    ['-n -nw 5', `flock -n -nw 5 l ${MERGE}`],
    ['-nw 5 と -c', `flock -nw 5 l -c '${MERGE}'`],
    ['-nw 5 と --command', `flock -nw 5 l --command '${MERGE}'`],
    ['値が - で始まる誤った書き方', `flock -nw -x l ${MERGE}`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['-nw 5 の安全なマージ', 'flock -nw 5 l gh pr merge 1 --squash --body x --match-head-commit a'],
    [
      '-nw5（値が束ねの中）の安全なマージ',
      'flock -nw5 l gh pr merge 1 --squash --body x --match-head-commit a',
    ],
    ['-nw 5 の gh pr view', 'flock -nw 5 l gh pr view 1'],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('flock の束ねたオプションの列が長くても後戻りで爆発しない（#2402）', () => {
  it('-nw の繰り返し', () => {
    const makeInput = (n: number) => `flock ${'-nw '.repeat(n)}x`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500, factor: 4 });
  });
  it('-nw 5 の繰り返し', () => {
    const makeInput = (n: number) => `flock ${'-nw 5 '.repeat(n)}x`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500, factor: 4 });
  });
  it('長い束ね', () => {
    const makeInput = (n: number) => `flock -${'n'.repeat(n)} x`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500, factor: 4 });
  });
});
