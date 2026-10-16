import { describe, expect, it } from 'vitest';

import { inspectWorkerBashShape } from './bash-worker-shape-guard.js';

function formOf(command: string): string | undefined {
  const v = inspectWorkerBashShape(command);
  return v.blocked ? v.form : undefined;
}

describe('inspectWorkerBashShape: 断る形（#4947）', () => {
  const cases: [string, string, string][] = [
    ['cat <<EOF\nhi\nEOF', 'worker-heredoc', 'Write'],
    ["cat <<'EOF' > a.txt\nhi\nEOF", 'worker-heredoc', 'Edit'],
    ['cat <<-EOF\n\thi\n\tEOF', 'worker-heredoc', 'Write'],
    ['echo hi > out.txt', 'worker-redirect', 'Write'],
    ['echo hi >> out.txt', 'worker-redirect', 'Write'],
    ['echo hi >| out.txt', 'worker-redirect', 'Write'],
    ['echo hi &> out.txt', 'worker-redirect', 'Write'],
    ['ls 3> out.txt', 'worker-redirect', 'Write'],
    ['pnpm test >/dev/null', 'worker-redirect', '| tail -n 20'],
    ['pnpm test 2>/dev/null', 'worker-redirect', '| grep'],
    ['pnpm test 2>&1', 'worker-fd-dup', '| tail'],
    ['echo x >&2', 'worker-fd-dup', '標準エラー'],
    ['pnpm test 2>&1 | tail -n 20', 'worker-fd-dup', '| tail'],
    ["sed -i 's/a/b/' f.ts", 'worker-sed-in-place', 'old_string'],
    ["sed -Ei 's/a/b/' f.ts", 'worker-sed-in-place', 'Edit'],
    ["sed -i.bak 's/a/b/' f.ts", 'worker-sed-in-place', 'Edit'],
    ["sed --in-place 's/a/b/' f.ts", 'worker-sed-in-place', 'Edit'],
    ["sed --in-place=.bak 's/a/b/' f.ts", 'worker-sed-in-place', 'Edit'],
    ["sed -n -e 'p' -i f.ts", 'worker-sed-in-place', 'Edit'],
    ["node -e 'console.log(1)'", 'worker-node-eval', 'Write'],
    ["node --eval 'console.log(1)'", 'worker-node-eval', 'Read'],
    ["node -p '1+1'", 'worker-node-eval', 'Write'],
    ["node --print '1+1'", 'worker-node-eval', 'Write'],
    ["node -pe '1+1'", 'worker-node-eval', 'Write'],
    ['python -c "print(1)"', 'worker-python-c', 'Write'],
    ['python3 -c "print(1)"', 'worker-python-c', 'grep'],
    ['python3 -Sc "print(1)"', 'worker-python-c', 'Write'],
    ["perl -e 'print 1'", 'worker-perl-eval', 'Write'],
    ["perl -pi -e 's/a/b/' f", 'worker-perl-eval', 'Edit'],
    ["perl -i.bak -pe 's/a/b/' f", 'worker-perl-eval', 'Edit'],
    ["cd x && sed -i 's/a/b/' f", 'worker-sed-in-place', 'Edit'],
    ["ls; node -e '1'", 'worker-node-eval', 'Write'],
    ["cat f | sed -i 's/a/b/'", 'worker-sed-in-place', 'Edit'],
    ["(python3 -c 'print(1)')", 'worker-python-c', 'Write'],
    ["timeout 60 node -e '1'", 'worker-node-eval', 'Write'],
    ["timeout -k 5 60 sed -i 's/a/b/' f", 'worker-sed-in-place', 'Edit'],
    ["FOO=1 python3 -c 'x'", 'worker-python-c', 'Write'],
    ["env FOO=1 -u BAR perl -e '1'", 'worker-perl-eval', 'Write'],
    ["sudo -u root sed -i 's/a/b/' f", 'worker-sed-in-place', 'Edit'],
    ["xargs -n 1 sed -i 's/a/b/'", 'worker-sed-in-place', 'Edit'],
    ["if true; then sed -i 's/a/b/' f; fi", 'worker-sed-in-place', 'Edit'],
    ["/usr/bin/sed -i 's/a/b/' f", 'worker-sed-in-place', 'Edit'],
    ['echo $(cat f > g)', 'worker-redirect', 'Write'],
    ['echo a\n# 注釈\necho b > c', 'worker-redirect', 'Write'],
  ];
  it.each(cases)('%j は %s で断り、理由に %s を含める', (command, form, hint) => {
    const v = inspectWorkerBashShape(command);
    expect(v.blocked).toBe(true);
    if (!v.blocked) return;
    expect(v.form).toBe(form);
    expect(v.reason).toContain(hint);
  });
});

describe('inspectWorkerBashShape: 断らないもの（誤検知の防ぎ）', () => {
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
    'ls | grep foo | tail -n 5',
    "bash -c 'tail -n 5 f'",
    "timeout 300 bash -c 'sleep 1; echo done'",
    "bash -c 'echo hi > f'",
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
    'pnpm test | tail -n 20',
    'find . -name "*.ts" -exec grep -l foo {} \\;',
    'pnpm exec vitest run --reporter=dot',
  ];
  it.each(ok)('%j は通す', (command) => {
    expect(inspectWorkerBashShape(command)).toEqual({ blocked: false });
  });

  it('形ごとの reason は Markdown の見出し・太字・箇条書きを含まない', () => {
    for (const command of [
      'cat <<EOF\nx\nEOF',
      'a > b',
      'a 2>&1',
      'sed -i x f',
      'node -e 1',
      'python -c 1',
      'perl -e 1',
    ]) {
      const v = inspectWorkerBashShape(command);
      expect(v.blocked && /\*\*|^#|^- /m.test(v.reason)).toBe(false);
    }
  });

  it('formOf は断らない形で undefined を返す', () => {
    expect(formOf('echo hi')).toBeUndefined();
  });
});
