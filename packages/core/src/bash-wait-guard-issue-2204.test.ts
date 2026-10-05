import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2204 —— C の横断レビュー（3周目）で見つかった、待つ形のガードの取りこぼし2件。
 * 直す前（main 01bb26d1）は、下の「弾く」のすべてが `blocked: false` だった（#2204 の本文、
 * C の実測。2026-09-29T15:3xZ）。
 *
 * このファイルはヒアドキュメントで書けない（本文のループの字面が本番の版のガードに弾かれる。#2130）。
 */
const LOOP = 'while true; do sleep 1; done';
const WRITE = `cat > run.sh <<'EOF'\n${LOOP}\nEOF\n`;

function expectBlocked(command: string, form: string): void {
  const verdict = inspectBashCommand(command);
  expect(verdict.blocked).toBe(true);
  if (!verdict.blocked) throw new Error('unreachable');
  expect(verdict.form).toBe(form);
}

describe('書いたファイルを $SHELL で走らせる形も、本文を実行すると読む（#2204 の 1）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['$SHELL', `${WRITE}$SHELL run.sh`],
    ['"$SHELL"', `${WRITE}"$SHELL" run.sh`],
    ['${SHELL}', `${WRITE}\${SHELL} run.sh`],
    ['"${SHELL}"', `${WRITE}"\${SHELL}" run.sh`],
    ['&& の後ろの $SHELL', `${WRITE.trimEnd()} && $SHELL run.sh`],
    ['$BASH（bash 自身のパス）', `${WRITE}$BASH run.sh`],
    ['exec $SHELL', `${WRITE}exec $SHELL run.sh`],
    // 直す前から弾けていた形（回帰の確かめ）
    ['bash', `${WRITE}bash run.sh`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      expectBlocked(command, 'while-sleep');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['書くだけ（走らせない）', WRITE.trimEnd()],
    ['$SHELL を echo するだけ', `${WRITE}echo $SHELL`],
    ['$SHELL のオプションだけ（-c は別の判定）', `${WRITE}$SHELL --version`],
    ['$SHELLX のような別の変数', `${WRITE}$SHELLX run.sh`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('条件に符号・先頭の 0 付きの定数を書いた C 形式の for も弾く（#2204 の 2）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['-1', 'for ((; -1 ;)); do sleep 1; done'],
    ['007', 'for ((;007;)); do sleep 1; done'],
    ['+5', 'for ((;+5;)); do sleep 1; done'],
    ['-007', 'for ((i=0; -007; i++)); do sleep 1; done'],
    // 直す前から弾けていた形（回帰の確かめ）
    ['空', 'for ((;;)); do sleep 1; done'],
    ['1', 'for ((;1;)); do sleep 1; done'],
  ];
  for (const [label, command] of blocked) {
    it(`条件 ${label}: 弾く`, () => {
      expectBlocked(command, 'for-sleep');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['0', 'for ((;0;)); do sleep 1; done'],
    ['00', 'for ((;00;)); do sleep 1; done'],
    ['-0', 'for ((; -0 ;)); do sleep 1; done'],
    ['+0', 'for ((;+0;)); do sleep 1; done'],
    ['変数との比較', 'for ((i=0; i<5; i++)); do sleep 1; done'],
    ['符号だけ', 'for ((;-;)); do sleep 1; done'],
  ];
  for (const [label, command] of passing) {
    it(`条件 ${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('#2204 の判定が、長い入力で2乗にならない', () => {
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['$SHELL の繰り返し', (n) => `${WRITE}${'$SHELL '.repeat(n)}x`, 1000],
    ['符号の付いた定数の for の繰り返し', (n) => `${'for ((;-1;)); do x; done; '.repeat(n)}`, 250],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が線形に終わる`, () => {
      // factor: 16（n..16n の5点）。この歯は線形でも傾きが揺れ、既定の factor=8 では通ったときの傾きの中央値が 3 回の実測で最大 1.3 を超え、閾値 1.5 に寄った（#3017。2206 と同じ扱い）。
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, {
        n,
        factor: 16,
      });
    });
  }
});
