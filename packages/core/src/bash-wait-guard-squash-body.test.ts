import { describe, expect, it } from 'vitest';

import { inspectBashCommand } from './bash-wait-guard.js';

/**
 * #1350 の決定 / #2280 — `gh pr merge` で squash を選び、本文（`--body` / `-b` / `--body-file` / `-F`）
 * を明示しない形を弾く。前置き・入れ子のシェル・引用符の値などの素通しの規則は
 * `--match-head-commit` の検出器と同じ部品に乗る。ここでは head は常に付ける
 * （head の欠落は `bash-wait-guard-match-head-commit.test.ts` の関心）。
 */
const SHA = '0123456789abcdef0123456789abcdef01234567';
const HEAD = `--match-head-commit ${SHA}`;
const FORM = 'gh-pr-merge-squash-no-body';

function blocked(command: string): boolean {
  const v = inspectBashCommand(command);
  return v.blocked && v.form === FORM;
}

describe('gh-pr-merge-squash-no-body: 弾く', () => {
  it.each([
    ['--squash だけ', `gh pr merge 123 --squash ${HEAD}`],
    ['-s だけ', `gh pr merge 123 -s ${HEAD}`],
    ['束ねた -sd 風（-s を含む）', `gh pr merge 123 -sa ${HEAD}`],
    ['--auto でも要る', `gh pr merge 123 --squash --auto ${HEAD}`],
    ['--subject だけ', `gh pr merge 123 --squash --subject "fix: x (#123)" ${HEAD}`],
    ['-R を挟む', `gh -R o/r pr merge 123 --squash ${HEAD}`],
    ['env 前置き', `GH_TOKEN=xxx gh pr merge 123 --squash ${HEAD}`],
    ['&& の後', `git fetch && gh pr merge 123 --squash ${HEAD}`],
    ['; の後', `echo a; gh pr merge 123 --squash ${HEAD}`],
    ['bash -c の中', `bash -c 'gh pr merge 123 --squash ${HEAD}'`],
    ['$( の中', `x=$(gh pr merge 123 --squash ${HEAD})`],
    [
      '2本目だけ本文が無い',
      `gh pr merge 1 --squash --body-file f ${HEAD} && gh pr merge 2 --squash ${HEAD}`,
    ],
    ['行の継続の先で squash', `gh pr merge 123 \\\n  --squash ${HEAD}`],
    ['別の語の接頭辞（--body-files）', `gh pr merge 1 --squash --body-files f ${HEAD}`],
    ['件名の値に --body の字面だけ', `gh pr merge 1 --squash --subject "x --body y" ${HEAD}`],
  ])('%s', (_name, command) => {
    expect(blocked(command)).toBe(true);
  });

  it('理由に本文を明示する理由と直し方の例が書いてある', () => {
    const v = inspectBashCommand(`gh pr merge 1 --squash ${HEAD}`);
    expect(v.blocked && v.reason).toContain('Co-authored-by');
    expect(v.blocked && v.reason).toContain('#1350');
    expect(v.blocked && v.reason).toContain(
      'gh pr merge <N> --squash --match-head-commit <sha> --body-file <file>',
    );
  });
});

describe('gh-pr-merge-squash-no-body: 通す', () => {
  it.each([
    ['--body', `gh pr merge 123 --squash ${HEAD} --body "本文"`],
    ['--body（単一引用符）', `gh pr merge 123 --squash ${HEAD} --body '本文'`],
    ['--body=...', `gh pr merge 123 --squash ${HEAD} --body="本文"`],
    ['--body-file', `gh pr merge 123 --squash ${HEAD} --body-file body.md`],
    ['--body-file=...', `gh pr merge 123 --squash ${HEAD} --body-file=body.md`],
    ['-b', `gh pr merge 123 -s ${HEAD} -b "本文"`],
    ['-F', `gh pr merge 123 -s ${HEAD} -F body.md`],
    ['束ねた -sb', `gh pr merge 123 ${HEAD} -sb "本文"`],
    ['本文を先に置く', `gh pr merge 123 --body-file f --squash ${HEAD}`],
    ['--auto と本文', `gh pr merge 123 --squash --auto ${HEAD} --body-file f`],
    [
      'ヒアドキュメントで本文',
      `gh pr merge 123 --squash ${HEAD} --body "$(cat <<'EOF'\nx\nEOF\n)"`,
    ],
    ['&& の後（本文あり）', `git fetch && gh pr merge 123 --squash ${HEAD} --body-file f`],
    ['bash -c の中（本文あり）', `bash -c 'gh pr merge 123 --squash ${HEAD} --body-file f'`],
    ['行の継続の先に本文', `gh pr merge 123 --squash ${HEAD} \\\n  --body-file f`],
    ['--merge（squash でない）', `gh pr merge 123 --merge ${HEAD}`],
    ['--rebase（squash でない）', `gh pr merge 123 --rebase ${HEAD}`],
    ['-m', `gh pr merge 123 -m ${HEAD}`],
    ['-r', `gh pr merge 123 -r ${HEAD}`],
    ['--disable-auto', 'gh pr merge 123 --disable-auto --squash'],
    ['--help', 'gh pr merge --help --squash'],
    ['echo の中の字面', 'echo "gh pr merge 123 --squash"'],
    ['gh pr view', 'gh pr view 123 --json headRefOid'],
    ['gh pr mergeable', 'gh pr mergeable 123 --squash'],
    ['ヒアドキュメントの本文に字面', `cat > f <<'EOF'\ngh pr merge 1 --squash ${HEAD}\nEOF`],
    ['件名の字面に gh pr merge', `git commit -m "docs: gh pr merge 1 --squash" && echo ok`],
  ])('%s', (_name, command) => {
    expect(blocked(command)).toBe(false);
  });

  it('読めない形（閉じていない引用符・空の入力）でも例外を出さず、squash でなければ通す', () => {
    expect(inspectBashCommand('').blocked).toBe(false);
    expect(blocked(`gh pr merge 1 --merge ${HEAD} --body "閉じていない`)).toBe(false);
  });
});

describe('gh-pr-merge-squash-no-body: 他の形との関係', () => {
  it('head も本文も欠けていれば、理由に両方を書く（形は head の欠落を優先）', () => {
    const v = inspectBashCommand('gh pr merge 1 --squash');
    expect(v.blocked && v.form).toBe('gh-pr-merge-no-match-head-commit');
    expect(v.blocked && v.reason).toContain('--match-head-commit <確かめた head の sha>');
    expect(v.blocked && v.reason).toContain('--body-file <file>');
  });

  it('head だけ欠けて本文が在れば、head の理由だけ', () => {
    const v = inspectBashCommand('gh pr merge 1 --squash --body-file f');
    expect(v.blocked && v.form).toBe('gh-pr-merge-no-match-head-commit');
    expect(v.blocked && v.reason).not.toContain('Co-authored-by');
  });

  it('squash でなく head が欠けていれば、head の理由だけ', () => {
    const v = inspectBashCommand('gh pr merge 1 --merge');
    expect(v.blocked && v.form).toBe('gh-pr-merge-no-match-head-commit');
    expect(v.blocked && v.reason).not.toContain('Co-authored-by');
  });

  it('delete-branch が先に効く（形が変わらない）', () => {
    const v = inspectBashCommand(`gh pr merge 1 --squash --delete-branch ${HEAD}`);
    expect(v.blocked && v.form).toBe('gh-pr-merge-delete-branch');
  });

  it('head と本文が揃っていれば通る', () => {
    expect(inspectBashCommand(`gh pr merge 1 --squash ${HEAD} --body-file f`).blocked).toBe(false);
  });
});
