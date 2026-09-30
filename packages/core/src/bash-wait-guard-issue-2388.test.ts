import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * #2388 — `$` やバッククォートを含む二重引用符の `--body` の値は前処理で潰されない（意図的）。
 * その値の中の `;` / `|` / `&` を区切りと読むと、`gh pr merge` の3つの形の区間が途中で切れ、
 * 正しいマージを弾く（偽陽性）・後ろの `-d` を素通しする、が起きていた。
 * 引用符の中の区切りは区切りとして読まない。引用符の外の区切りは、これまでどおり効く。
 */
function formOf(command: string): string | undefined {
  const v = inspectBashCommand(command);
  return v.blocked ? v.form : undefined;
}

describe('#2388: 引用符の中の区切りは区切りと読まない', () => {
  it.each([
    [
      '$ を含む二重引用符の本文の ;',
      'gh pr merge 12 --squash --body "Fixes $ISSUE; thanks" --match-head-commit abc',
    ],
    [
      'バッククォートを含む本文の |',
      'gh pr merge 12 --squash --body "use `a | b`" --match-head-commit abc',
    ],
    ['本文の && と $', 'gh pr merge 12 --squash --body "a $X && b" --match-head-commit abc'],
    ['単一引用符の本文の ;', "gh pr merge 12 --squash --body 'a; b' --match-head-commit abc"],
    ["$'…' の本文の ;", "gh pr merge 12 --squash --body $'a; b' --match-head-commit abc"],
    ['フラグの順を替える', 'gh pr merge 12 --body "x $Y; z" --squash --match-head-commit abc'],
  ])('通す: %s', (_name, command) => {
    expect(formOf(command)).toBeUndefined();
  });

  it.each([
    [
      '$ を含む本文の ; の後の -d',
      'gh pr merge 12 --squash --match-head-commit abc --body "Fixes $ISSUE; thanks" -d',
    ],
    [
      'バッククォートを含む本文の | の後の --delete-branch',
      'gh pr merge 12 --squash --match-head-commit abc --body "use `a | b`" --delete-branch',
    ],
    [
      '単一引用符の本文の ; の後の -d',
      "gh pr merge 12 --squash --match-head-commit abc --body 'a; b' -d",
    ],
  ])('弾く（delete-branch）: %s', (_name, command) => {
    expect(formOf(command)).toBe('gh-pr-merge-delete-branch');
  });

  it('本文の ; の前の -d も弾く', () => {
    expect(
      formOf('gh pr merge 12 --squash -d --match-head-commit abc --body "Fixes $ISSUE; thanks"'),
    ).toBe('gh-pr-merge-delete-branch');
  });

  it('本文が $ を含み、head が無いものは引き続き弾く', () => {
    expect(formOf('gh pr merge 12 --squash --body "Fixes $ISSUE; thanks"')).toBe(
      'gh-pr-merge-no-match-head-commit',
    );
  });

  it('本文が $ を含み、head が本文の外の ; の後ろにしか無いものは弾く', () => {
    expect(
      formOf('gh pr merge 12 --merge --body "a $X; b"; gh pr view 1 --match-head-commit abc'),
    ).toBe('gh-pr-merge-no-match-head-commit');
  });

  it('本文が無い squash は引き続き弾く（引用符の中の区切りがあっても）', () => {
    expect(formOf('gh pr merge 12 --squash --subject "a $X; b" --match-head-commit abc')).toBe(
      'gh-pr-merge-squash-no-body',
    );
  });
});

describe('#2388: 引用符の外の区切りは引き続き区切りとして効く', () => {
  it.each([
    ['; の後の別コマンドの -d', 'gh pr merge 1 --match-head-commit a; git branch -d x'],
    ['&& の後の別コマンドの -d', 'gh pr merge 1 --match-head-commit a && git branch -d x'],
    ['| の後の別コマンドの -d', 'gh pr merge 1 --match-head-commit a | git branch -d x'],
    [
      '本文付きでも ; の後の -d は別コマンド',
      'gh pr merge 1 --body "a $X; b" --match-head-commit a; git branch -d x',
    ],
  ])('通す: %s', (_name, command) => {
    expect(formOf(command)).toBeUndefined();
  });

  it('; の後ろの --match-head-commit は、前の呼び出しのものとは読まない', () => {
    expect(formOf('gh pr merge 1 --merge; echo --match-head-commit a')).toBe(
      'gh-pr-merge-no-match-head-commit',
    );
  });
});
