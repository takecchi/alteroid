import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';
import { expectNotSuperlinear } from './time-growth.test-support.js';

/**
 * Issue #2397 —— `SHELL_DASH_C_RE` が、シェル名と `-c` のあいだのオプション列
 * （`-e`・`-euo pipefail`・`-o pipefail`・`--norc`）を読み飛ばさず、`-c` の中の
 * `gh pr merge` の門が効かなかった。`-c --` も許す。
 */
const MERGE = 'gh pr merge 1 --squash --body x --match-head-commit a -d';

describe('シェル名と -c のあいだのオプション（#2397）', () => {
  const blocked: ReadonlyArray<[string, string]> = [
    ['対照: bash -c', `bash -c '${MERGE}'`],
    ['-euo pipefail -c', `bash -euo pipefail -c '${MERGE}'`],
    ['-e -c', `bash -e -c '${MERGE}'`],
    ['-o pipefail -c', `bash -o pipefail -c '${MERGE}'`],
    ['+o errexit -c', `bash +o errexit -c '${MERGE}'`],
    ['--norc -c', `bash --norc -c '${MERGE}'`],
    ['--norc --noprofile -c', `bash --norc --noprofile -c '${MERGE}'`],
    ['束ね -ec', `bash -ec '${MERGE}'`],
    ['-c --', `bash -c -- '${MERGE}'`],
    ['-e -c --', `bash -e -c -- '${MERGE}'`],
    ['sh -eu -c', `sh -eu -c '${MERGE}'`],
    ['二重引用符', `bash -e -c "${MERGE}"`],
    ['パス付きシェル', `/bin/bash -euo pipefail -c '${MERGE}'`],
  ];
  for (const [label, command] of blocked) {
    it(`${label}: 弾く`, () => {
      expect(inspectBashCommand(command).blocked).toBe(true);
    });
  }

  const passing: ReadonlyArray<[string, string]> = [
    ['-c の中が門に触れない', `bash -euo pipefail -c 'gh pr view 1'`],
    ['スクリプトの引数の -c は読まない', `bash script.sh -c '${MERGE}'`],
    ['-c の中が安全なマージ', `bash -e -c 'gh pr merge 1 --squash --body x --match-head-commit a'`],
  ];
  for (const [label, command] of passing) {
    it(`${label}: 通す`, () => {
      expect(inspectBashCommand(command).blocked).toBe(false);
    });
  }
});

describe('シェル名と -c のあいだのオプション列が長くても後戻りで爆発しない（#2397）', () => {
  it('-e の繰り返し（-c が無い）', () => {
    const makeInput = (n: number) => `bash ${'-e '.repeat(n)}x`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500, factor: 4 });
  });
  it('-o 値 の繰り返し（-c が無い）', () => {
    const makeInput = (n: number) => `bash ${'-o pipefail '.repeat(n)}x`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500, factor: 4 });
  });
  it('-o -o の繰り返し（値が - 始まり）', () => {
    const makeInput = (n: number) => `bash ${'-o '.repeat(n)}x`;
    expectNotSuperlinear(inspectBashCommand, makeInput, { n: 500, factor: 4 });
  });
});
