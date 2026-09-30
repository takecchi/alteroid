import {
  inspectBashCommand as inspectRaw,
  type BashInvocation,
  type WaitGuardVerdict,
} from './bash-wait-guard.js';

/**
 * `gh-pr-merge-delete-branch` の歯用の判定器。`--match-head-commit` の無い `gh pr merge`
 * を弾く検出器（#1192 N7。歯は `bash-wait-guard-match-head-commit.test.ts`）は、この歯の
 * 関心（`--delete-branch` / `-d` を見分けること）と直交する。歯の入力には `--match-head-commit`
 * を持たない `gh pr merge` が多いので、新しい形だけを「弾かない」に読み替える。
 * delete-branch の判定・素通しの規則は 1 文字も変えない。
 */
export function inspectBashCommand(
  command: string,
  invocation: BashInvocation = {},
): WaitGuardVerdict {
  const verdict = inspectRaw(command, invocation);
  // squash に本文が無い形（#2280）も、この歯の関心と直交するので同じく読み替える。
  if (
    verdict.blocked &&
    (verdict.form === 'gh-pr-merge-no-match-head-commit' ||
      verdict.form === 'gh-pr-merge-squash-no-body')
  ) {
    return { blocked: false };
  }
  return verdict;
}
