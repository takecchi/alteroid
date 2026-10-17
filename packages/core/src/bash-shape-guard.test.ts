import { describe, expect, it } from 'vitest';

import { BASH_SHAPE_CONTINUE_NOTE, inspectBashShape } from './bash-shape-guard.js';

function formOf(command: string): string | undefined {
  const v = inspectBashShape(command);
  return v.blocked ? v.form : undefined;
}

describe('inspectBashShape: 断る形（#4947）', () => {
  const cases: [string, string, string][] = [
    ['cat <<EOF\nhi\nEOF', 'heredoc', 'Write'],
    ["cat <<'EOF' > a.txt\nhi\nEOF", 'heredoc', 'Edit'],
    ['cat <<-EOF\n\thi\n\tEOF', 'heredoc', 'Write'],
    ['echo hi > out.txt', 'redirect', 'Write'],
    ['echo hi >> out.txt', 'redirect', 'Write'],
    ['echo hi >| out.txt', 'redirect', 'Write'],
    ['echo hi &> out.txt', 'redirect', 'Write'],
    ['ls 3> out.txt', 'redirect', 'Write'],
    ['pnpm test >/dev/null', 'redirect', 'リダイレクトを外してそのまま打ち'],
    ['pnpm test 2>/dev/null', 'redirect', '出力を読む'],
    ['pnpm test 2>&1', 'fd-dup', '付け替えを外して'],
    ['echo x >&2', 'fd-dup', '標準エラー'],
    ['pnpm test 2>&1 | tail -n 20', 'fd-dup', '付け替えを外して'],
    ["sed -i 's/a/b/' f.ts", 'sed-in-place', 'old_string'],
    ["sed -Ei 's/a/b/' f.ts", 'sed-in-place', 'Edit'],
    ["sed -i.bak 's/a/b/' f.ts", 'sed-in-place', 'Edit'],
    ["sed --in-place 's/a/b/' f.ts", 'sed-in-place', 'Edit'],
    ["sed --in-place=.bak 's/a/b/' f.ts", 'sed-in-place', 'Edit'],
    ["sed -n -e 'p' -i f.ts", 'sed-in-place', 'Edit'],
    ["node -e 'console.log(1)'", 'node-eval', 'Write'],
    ["node --eval 'console.log(1)'", 'node-eval', 'Read'],
    ["node -p '1+1'", 'node-eval', 'Write'],
    ["node --print '1+1'", 'node-eval', 'Write'],
    ["node -pe '1+1'", 'node-eval', 'Write'],
    ['python -c "print(1)"', 'python-c', 'Write'],
    ['python3 -c "print(1)"', 'python-c', 'grep'],
    ['python3 -Sc "print(1)"', 'python-c', 'Write'],
    ["perl -e 'print 1'", 'perl-eval', 'Write'],
    ["perl -pi -e 's/a/b/' f", 'perl-eval', 'Edit'],
    ["perl -i.bak -pe 's/a/b/' f", 'perl-eval', 'Edit'],
    ["cd x && sed -i 's/a/b/' f", 'sed-in-place', 'Edit'],
    ["ls; node -e '1'", 'node-eval', 'Write'],
    ["cat f | sed -i 's/a/b/'", 'sed-in-place', 'Edit'],
    ["(python3 -c 'print(1)')", 'python-c', 'Write'],
    ["timeout 60 node -e '1'", 'node-eval', 'Write'],
    ["timeout -k 5 60 sed -i 's/a/b/' f", 'sed-in-place', 'Edit'],
    ["FOO=1 python3 -c 'x'", 'python-c', 'Write'],
    ["env FOO=1 -u BAR perl -e '1'", 'perl-eval', 'Write'],
    ["sudo -u root sed -i 's/a/b/' f", 'sed-in-place', 'Edit'],
    ["xargs -n 1 sed -i 's/a/b/'", 'sed-in-place', 'Edit'],
    ["if true; then sed -i 's/a/b/' f; fi", 'sed-in-place', 'Edit'],
    ["/usr/bin/sed -i 's/a/b/' f", 'sed-in-place', 'Edit'],
    ['echo $(cat f > g)', 'redirect', 'Write'],
    ['echo a\n# 注釈\necho b > c', 'redirect', 'Write'],
  ];
  it.each(cases)('%j は %s で断り、理由に %s を含める', (command, form, hint) => {
    const v = inspectBashShape(command);
    expect(v.blocked).toBe(true);
    if (!v.blocked) return;
    expect(v.form).toBe(form);
    expect(v.reason).toContain(hint);
  });
});

describe('inspectBashShape: 足した形（#4949）', () => {
  const cases: [string, string, string][] = [
    // 1. `|&`
    ['pnpm test |& tail -n 20', 'pipe-stderr', '`|&` を外して'],
    ['make |& grep error', 'pipe-stderr', '標準エラー'],
    // 2. bash -c / sh -c の引数の中
    // 2026-10-16 #4949: `bash -c 'echo hi > f'` は以前は通していた（#4947 では引用符の中の形を見なかった）が、引数の引用符を1段はがして中を読むようにしたので断る
    ["bash -c 'echo hi > f'", 'redirect', 'Write'],
    ["timeout 300 bash -c 'pnpm test 2>&1'", 'fd-dup', '付け替えを外して'],
    ['sh -c "cat <<EOF\nx\nEOF"', 'heredoc', 'Write'],
    ["bash -lc 'sed -i s/a/b/ f'", 'sed-in-place', 'Edit'],
    ["bash -c 'git reset --hard'", 'git-reset', 'git restore --staged'],
    ["bash -c 'make |& tail'", 'pipe-stderr', '`|&` を外して'],
    ["sudo bash -c 'echo x >> /etc/f'", 'redirect', 'Write'],
    // 3. 二重引用符の中のコマンド置換・バッククォート
    [
      "git commit -m \"$(cat <<'EOF'\nfix: it's\n\nbody\nEOF\n)\"",
      'subst-heredoc',
      'git commit -F',
    ],
    ['gh pr create --body "$(cat <<EOF\nx\nEOF\n)"', 'subst-heredoc', '--body-file'],
    ['echo "`cat <<EOF\nx\nEOF\n`"', 'subst-heredoc', 'git commit -F'],
    ['echo "$(cat f > g)"', 'redirect', 'Write'],
    ['echo "a $(pnpm test 2>&1) b"', 'fd-dup', '付け替えを外して'],
    ['echo "`pnpm test 2>/dev/null`"', 'redirect', '出力を読む'],
    ['echo "$(echo "x" | sed -i s/a/b/ f)"', 'sed-in-place', 'Edit'],
    ['echo "$(git reset --hard)"', 'git-reset', 'git revert'],
    // 4. git reset（全ての形）
    ['git reset', 'git-reset', 'git restore --staged'],
    ['git reset --hard origin/main', 'git-reset', '依頼者へ確かめる'],
    ['git reset --soft HEAD~1', 'git-reset', 'git revert'],
    ['git reset HEAD a.ts', 'git-reset', 'git restore --staged'],
    ['cd x && git reset --mixed', 'git-reset', 'git revert'],
    // git の全体の選択肢を読み飛ばす
    ['git -C /tmp/x reset --hard', 'git-reset', 'git revert'],
    ['git -c core.editor=true rebase main', 'git-rebase', 'git merge origin/main'],
    ['git --git-dir=/a/.git --work-tree=/a reset', 'git-reset', 'git revert'],
    ['git --no-pager -P reset --hard', 'git-reset', 'git revert'],
    ['git --namespace=ns push --force', 'git-force-push', '新しい枝'],
    ['git --git-dir /a/.git push -f origin x', 'git-force-push', '新しい枝'],
    ['FOO=1 /usr/bin/git reset --hard', 'git-reset', 'git revert'],
    ['sudo -u x git reset --hard', 'git-reset', 'git revert'],
    ['if true; then git reset --hard; fi', 'git-reset', 'git revert'],
    // 5. force push
    ['git push --force', 'git-force-push', '新しいコミットを積んで'],
    ['git push origin main --force', 'git-force-push', '新しい枝'],
    ['git push --force-with-lease', 'git-force-push', '新しい枝'],
    ['git push --force-with-lease=main:abc origin main', 'git-force-push', '新しい枝'],
    ['git push --force-if-includes', 'git-force-push', '新しい枝'],
    ['git push -f origin x', 'git-force-push', '新しい枝'],
    ['git push -uf origin x', 'git-force-push', '新しい枝'],
    ['git push -fu origin x', 'git-force-push', '新しい枝'],
    ['git push origin +main', 'git-force-push', '新しい枝'],
    ['git push origin +main:main', 'git-force-push', '新しい枝'],
    ['git push origin HEAD:refs/heads/x +HEAD:y', 'git-force-push', '新しい枝'],
    // 6. rebase
    ['git rebase origin/main', 'git-rebase', 'git merge origin/main'],
    ['git rebase --continue', 'git-rebase', 'git merge origin/main'],
    ['git rebase --skip', 'git-rebase', 'git rebase --abort'],
    ['git rebase --abort origin/main', 'git-rebase', 'git merge origin/main'],
    ['git pull --rebase', 'git-rebase', 'git merge origin/main'],
    ['git pull --rebase=true origin main', 'git-rebase', 'git merge origin/main'],
    ['git pull -r', 'git-rebase', 'git merge origin/main'],
    ['git pull -qr origin main', 'git-rebase', 'git merge origin/main'],
    // 7. --no-verify / git commit -n
    ['git commit --no-verify -m x', 'no-verify', 'フックが落ちた'],
    ['git commit -m x --no-verify', 'no-verify', 'フックが落ちた'],
    ['git push --no-verify', 'no-verify', 'フックが落ちた'],
    ['git merge --no-verify x', 'no-verify', 'フックが落ちた'],
    ['git commit -n -m x', 'no-verify', 'フックが落ちた'],
    ['git commit -an -m x', 'no-verify', 'フックが落ちた'],
    ['git -C /tmp/x commit -n', 'no-verify', 'フックが落ちた'],
    // 8. gh pr merge --auto
    ['gh pr merge 1 --auto', 'gh-merge-auto', 'gh run watch'],
    ['gh pr merge --auto --squash 12', 'gh-merge-auto', '--match-head-commit'],
    ['gh pr merge 1 --squash --auto -R takecchi/alteroid', 'gh-merge-auto', 'gh run watch'],
    ['gh -R takecchi/alteroid pr merge 1 --auto', 'gh-merge-auto', 'gh run watch'],
    ['cd x && gh pr merge 1 --auto', 'gh-merge-auto', 'gh run watch'],
  ];
  it.each(cases)('%j は %s で断り、理由に %s を含める', (command, form, hint) => {
    const v = inspectBashShape(command);
    expect(v.blocked).toBe(true);
    if (!v.blocked) return;
    expect(v.form).toBe(form);
    expect(v.reason).toContain(hint);
  });

  it('bash -c の入れ子は1段だけ読む（2段以上は既知の穴で断らない）', () => {
    expect(formOf('bash -c "bash -c \'echo hi > f\'"')).toBeUndefined();
    expect(formOf("bash -c 'echo hi > f'")).toBe('redirect');
  });

  it('深く入れ子にした置換でも、上限で止まって投げない', () => {
    let command = 'echo x';
    for (let i = 0; i < 40; i += 1) command = `echo "$(${command})"`;
    expect(() => inspectBashShape(command)).not.toThrow();
  });
});

describe('inspectBashShape: 断らないもの（誤検知の防ぎ）', () => {
  const ok = [
    'gh pr create --body "a > b"',
    "grep '2>&1' f.ts",
    'git commit -m "sed -i をやめる"',
    "git commit -m 'node -e は使わない'",
    'echo "cat <<EOF"',
    'echo hi # > out.txt',
    'echo hi # sed -i f',
    'echo hi # 2>&1',
    'sort < in.txt',
    'cat <<< "hello"',
    'diff <(ls a) <(ls b)',
    // #5017: `| tail` で終わる管は pipe-trim で断つようになったので、管の途中を通す例は最後の段を変えた
    'ls | grep foo | wc -l',
    "bash -c 'tail -n 5 f'",
    // #5017: `;` で繋ぐ形は chain で断つようになったので、timeout の包みを通す例は `;` を外した
    "timeout 300 bash -c 'sleep 1 && echo done'",
    "sed -n '1,5p' f.ts",
    "sed 's/a/b/' f.ts",
    'sed -e "s/-i/x/" f.ts',
    "grep -rn 'sed -i' src",
    'echo sed -i',
    'echo node -e',
    'node script.mjs -e foo',
    'node /abs/script.mjs',
    'node -r ts-node/register script.js -p 1',
    'node --version',
    'python3 /abs/script.py -c conf',
    'python3 -m pytest -c conf.ini',
    'python3 --version',
    'perl /abs/script.pl -e',
    'perl -MList::Util=sum script.pl',
    'echo $((1 > 0))',
    '[[ b > a ]] && echo ok',
    'echo a \\> b',
    'tee >(grep x) < f',
    'pnpm test | grep FAIL',
    'find . -name "*.ts" -exec grep -l foo {} \\;',
    'pnpm exec vitest run --reporter=dot',
    // #4949 で足した形の誤検知の防ぎ
    'echo git reset',
    'gh pr create --body "git reset と --no-verify を避ける"',
    'git log --oneline',
    'git push -u origin feat/x',
    'git restore --staged a.ts',
    'git merge origin/main',
    'gh pr merge 1 --squash --match-head-commit abc',
    "timeout 300 bash -c 'until test -f x; do sleep 5; done'",
    'grep -n "rebase" a.ts',
    'git commit -F /tmp/x/msg.txt',
    'git commit -m "plain"',
    'git push origin main:main',
    'echo "git push --force"',
    "echo 'git rebase main'",
    'echo gh pr merge 1 --auto',
    'git commit -m "docs: --no-verify を使わない"',
    'git commit -m "wip -n"',
    'git commit -m x -- -n',
    'git commit -am "fix: reset the state"',
    'git commit -F /tmp/x/msg.txt && git push -u origin x',
    'git -C /tmp/x log --oneline',
    'git -c core.pager=cat diff',
    'git --no-pager log -n 5',
    'git pull --rebase=false',
    'git pull --no-rebase origin main',
    // 途中で止まった rebase から抜けるだけの形は通す（#4957）
    'git rebase --abort',
    'git rebase --quit',
    'git -C /tmp/x rebase --abort',
    'git pull -Xtheirs origin main',
    'git pull origin main',
    'git push --follow-tags origin main',
    'git push --force-with-leasex',
    'git push -u origin feat/x --no-thin',
    'git push origin feat/x:feat/y',
    'git fetch --prune',
    'git stash push -m "reset"',
    'git branch -D old',
    'git revert HEAD',
    'git cherry-pick abc',
    'gh pr merge 1 --squash',
    'gh pr create --title "x --auto"',
    'gh pr view 1 --json state',
    'gh run watch 123 --exit-status',
    'timeout 530 gh run watch 123 --exit-status',
    'for i in $(seq 60); do test -f x && break; sleep 5; done',
    'echo "$(date)"',
    'echo "`date`"',
    'echo "$(git log --oneline -n 3)"',
    'echo "$((1 > 0))"',
    "echo '$(cat <<EOF'",
    'echo \'"$(cat f > g)"\'',
    'gh pr create --body "$(printf "%s" "a > b")"',
    'git commit -m "$(date)"',
    'echo "$(echo "it\'s" | tr a b)"',
    'bash script.sh',
    'bash -n script.sh',
    "bash -c 'git log --oneline | wc -l'",
    'echo "# $(date)"',
  ];
  it.each(ok)('%j は通す', (command) => {
    expect(inspectBashShape(command)).toEqual({ blocked: false });
  });

  it('形ごとの reason は Markdown の見出し・太字・箇条書きを含まず、主語を作業者に限らない', () => {
    for (const command of [
      'cat <<EOF\nx\nEOF',
      'echo "$(cat <<EOF\nx\nEOF\n)"',
      'a > b',
      'a 2>&1',
      'a |& b',
      'sed -i x f',
      'node -e 1',
      'python -c 1',
      'perl -e 1',
      'git reset',
      'git push -f',
      'git rebase x',
      'git commit --no-verify',
      'gh pr merge 1 --auto',
    ]) {
      const v = inspectBashShape(command);
      expect(v.blocked).toBe(true);
      expect(v.blocked && /\*\*|^#|^- /m.test(v.reason)).toBe(false);
      expect(v.blocked && v.reason.includes('作業者')).toBe(false);
      // 最初の1文で「通らない」と代わりの書き方を言い、続けてよいと締める（#4989）。管で絞ることは勧めない（#4990）
      expect(v.blocked && v.reason.includes('通らない')).toBe(true);
      expect(v.blocked && v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
      expect(v.blocked && v.reason.includes('| tail')).toBe(false);
    }
  });

  it('formOf は断らない形で undefined を返す', () => {
    expect(formOf('echo hi')).toBeUndefined();
  });
});
