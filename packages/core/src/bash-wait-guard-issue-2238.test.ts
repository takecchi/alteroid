import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2238 —— マージのガードの入れ子のシェルの取り出し（#2104）が、シェルの名前の列挙
 * （`SHELL_NAME_SRC`）にしか当てず、`$SHELL -c "…"` / `"$SHELL" -c '…'` の中身を取り出さずに
 * 通していた。直す前（main fd98ce69）は、下の「弾く」のうち `bash -c` 以外のすべてが
 * `blocked: false` だった（2026-09-29T19:4xZ、#2238 の本文の実測）。
 */
const MERGE = ['gh', 'pr', 'merge', '1', '--squash', '--delete-branch'].join(' ');

describe('マージのガードは、シェルを変数で書いた入れ子も取り出す（#2238）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['$SHELL -c', `$SHELL -c "${MERGE}"`],
    ['"$SHELL" -c', `"$SHELL" -c '${MERGE}'`],
    ['${SHELL} -c', `\${SHELL} -c "${MERGE}"`],
    ['$BASH -c', `$BASH -c "${MERGE}"`],
    ['パイプの先の $SHELL', `echo "${MERGE}" | $SHELL`],
    // 直す前から弾けていた形（回帰の確かめ）
    ['bash -c', `bash -c "${MERGE}"`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      const verdict = inspectBashCommand(command);
      expect(verdict.blocked).toBe(true);
      if (!verdict.blocked) throw new Error('unreachable');
      expect(verdict.form).toBe('gh-pr-merge-delete-branch');
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['$SHELL を echo するだけ', 'echo $SHELL'],
    ['$SHELL --version', '$SHELL --version'],
    ['$SHELL -c の中身がマージでない', `$SHELL -c "gh pr view 1"`],
    ['別の変数', `$SHELLX -c "${MERGE}"`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('変数の形を足した取り出しが、長い入力で2乗にならない（#2238）', () => {
  const cases: ReadonlyArray<[string, (n: number) => string, number]> = [
    ['$SHELL の繰り返し', (n) => `${'$SHELL '.repeat(n)}x`, 1000],
    ['"$SHELL" -c の繰り返し', (n) => `${'"$SHELL" -c x; '.repeat(n)}x`, 500],
  ];
  for (const [label, makeInput, n] of cases) {
    it(`${label}が線形に終わる`, () => {
      expectNotSuperlinear((command: string) => inspectBashCommand(command), makeInput, { n });
    });
  }
});
