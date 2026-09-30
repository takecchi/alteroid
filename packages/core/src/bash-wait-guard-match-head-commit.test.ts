import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * #1192 N7 — `gh pr merge` に `--match-head-commit <sha>` が無い形を弾く。
 * 前置き・入れ子のシェル・件名の字面などの素通しの規則は delete-branch の検出器と同じ部品に乗る。
 */
const SHA = '0123456789abcdef0123456789abcdef01234567';
const FORM = 'gh-pr-merge-no-match-head-commit';

function blocked(command: string): boolean {
  const v = inspectBashCommand(command);
  return v.blocked && v.form === FORM;
}

describe('gh-pr-merge-no-match-head-commit: 弾く', () => {
  it.each([
    ['素の形', 'gh pr merge 123 --squash'],
    ['引数無し', 'gh pr merge'],
    ['--auto でも要る', 'gh pr merge 123 --squash --auto'],
    ['--admin でも要る', 'gh pr merge 123 --squash --admin'],
    ['--repo を挟む', 'gh -R o/r pr merge 123 --squash'],
    ['env 前置き', 'GH_TOKEN=xxx gh pr merge 123 --squash'],
    ['timeout 前置き', 'timeout 60 gh pr merge 123 --squash'],
    ['&& の後', 'git fetch && gh pr merge 123 --squash'],
    ['; の後', 'echo a; gh pr merge 123 --squash'],
    ['bash -c の中', `bash -c 'gh pr merge 123 --squash'`],
    ['$( の中', 'x=$(gh pr merge 123 --squash)'],
    ['値が空（=）', 'gh pr merge 123 --squash --match-head-commit='],
    ['値が空（引用符）', 'gh pr merge 123 --squash --match-head-commit ""'],
    ['値が無い（末尾）', 'gh pr merge 123 --squash --match-head-commit'],
    ['値の代わりに次のフラグ', 'gh pr merge 123 --match-head-commit --squash'],
    ['2本目だけ欠ける', `gh pr merge 1 --match-head-commit ${SHA} && gh pr merge 2 --squash`],
    ['件名に字面が在るだけ', `gh pr merge 1 --subject "x --match-head-commit ${SHA}"`],
    ['別の語の接頭辞', `gh pr merge 1 --match-head-commits ${SHA}`],
  ])('%s', (_name, command) => {
    expect(blocked(command)).toBe(true);
  });

  it('理由に足すものと理由が書いてある', () => {
    const v = inspectBashCommand('gh pr merge 1 --squash');
    expect(v.blocked && v.reason).toContain('--match-head-commit <確かめた head の sha>');
    expect(v.blocked && v.reason).toContain('マージされる head');
  });
});

describe('gh-pr-merge-no-match-head-commit: 通す', () => {
  it.each([
    ['スペース区切り', `gh pr merge 123 --squash --match-head-commit ${SHA}`],
    ['= 区切り', `gh pr merge 123 --squash --match-head-commit=${SHA}`],
    ['先頭に置く', `gh pr merge --match-head-commit ${SHA} 123 --squash`],
    ['引用符付きの値', `gh pr merge 123 --squash --match-head-commit "${SHA}"`],
    ['変数の値', 'gh pr merge 123 --squash --match-head-commit "$HEAD_SHA"'],
    ['--auto', `gh pr merge 123 --squash --auto --match-head-commit ${SHA}`],
    ['env 前置き', `GH_TOKEN=xxx gh pr merge 123 --match-head-commit ${SHA}`],
    ['&& の後', `git fetch && gh pr merge 123 --match-head-commit ${SHA}`],
    ['bash -c の中', `bash -c 'gh pr merge 123 --match-head-commit ${SHA}'`],
    ['行の継続の先', `gh pr merge 123 \\\n  --match-head-commit ${SHA}`],
    ['--disable-auto（マージしない）', 'gh pr merge 123 --disable-auto'],
    ['--help', 'gh pr merge --help'],
    ['echo の中の字面', 'echo "gh pr merge 123 --squash"'],
    ['echo の中の字面（単一引用符）', `echo 'gh pr merge 123'`],
    ['gh pr view', 'gh pr view 123 --json headRefOid'],
    ['gh pr merge を語に含む別コマンド', 'gh pr mergeable 123'],
    [
      '件名の字面に gh pr merge',
      `git commit -m "docs: gh pr merge 1 の例" && gh pr merge 1 --match-head-commit ${SHA}`,
    ],
    [
      '件名の中の字面（--subject）',
      `gh pr merge 1 --subject "fix: gh pr merge の件名" --match-head-commit ${SHA}`,
    ],
    ['ヒアドキュメントの本文', `cat > f <<'EOF'\ngh pr merge 1 --squash\nEOF`],
  ])('%s', (_name, command) => {
    expect(blocked(command)).toBe(false);
  });

  it('delete-branch の検出器が先に効く（形が変わらない）', () => {
    const v = inspectBashCommand('gh pr merge 1 --squash --delete-branch');
    expect(v.blocked && v.form).toBe('gh-pr-merge-delete-branch');
  });
});
