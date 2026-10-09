import { describe, expect, it } from 'vitest';

import {
  BASH_FILE_WRITE_GUARD_ENV,
  DEFAULT_BASH_FILE_WRITE_GUARD,
  resolveBashFileWriteGuardMode,
} from './bash-file-write-guard-mode.js';
import { inspectBashFileWrite, type BashFileWriteForm } from './bash-file-write-guard.js';

function formOf(command: string): BashFileWriteForm | undefined {
  const verdict = inspectBashFileWrite(command);
  return verdict.blocked ? verdict.form : undefined;
}

const F1 = [
  'cat > f <<EOF\nhello\nEOF',
  "cat >> notes.txt <<'EOF'\nit's here\nEOF",
  'tee f <<EOF\nx\nEOF',
  'cat <<EOF > f\nx\nEOF',
  'cat > f <<< "text"',
  'cat > /dev/null <<EOF\nEOF',
  "cat > /dev/null <<'EOF'\nEOF",
  'echo done && cat > "$OUT" <<EOF\nx\nEOF',
];

const F2 = [
  "sed -i 's/a/b/' f",
  "sed -i.bak 's/a/b/' f",
  "sed -ni 's/a/b/p' f",
  "sed -Ei 's/a/b/' f",
  "sed --in-place 's/a/b/' f",
  "perl -pi -e 's/a/b/' f",
  "perl -i.bak -pe 's/a/b/' f",
  "ruby -i -pe '$_.upcase!' f",
  "awk -i inplace '{print}' f",
  "gawk -i inplace '{print}' f",
  "FOO=1 sudo sed -i 's/a/b/' f",
];

const F3 = [
  "python3 - <<'EOF'\nopen('f', 'w').write('x')\nEOF",
  "python3 -c \"open('f', 'w').write('x')\"",
  'python3 -c \'from pathlib import Path; Path("f").write_text("x")\'',
  "node -e \"require('fs').writeFileSync('f', 'x')\"",
  "node --eval \"require('fs').appendFileSync('f', 'x')\"",
  "node - <<'EOF'\nrequire('fs').writeFileSync('f','x')\nEOF",
  'perl -e \'open(F, ">f"); print F 1\'',
  'ruby -e \'File.write("f", "x")\'',
  'python3 -c \'import shutil; shutil.rmtree("d")\'',
  'python3 -c \'import os; os.remove("f")\'',
  "echo \"open('f','w').write('x')\" | python3 -",
];

const F4 = [
  'pnpm typecheck > tc.log',
  'pnpm test >> out.log',
  'pnpm test 2> err.log',
  'pnpm test &> all.log',
  'pnpm test > /tmp/x/tc.log 2>&1',
  'pnpm test | tee out.log',
  'pnpm test | tee -a out.log',
  'cat <<EOF | tee out.txt\nx\nEOF',
  'echo hi >f',
  'echo a; echo b > f',
  'ls && pwd > "$OUT"',
  'x=$(echo a > f)',
];

const PASS = [
  // E1: 引数や標準入力へ渡すだけの heredoc
  'git commit -F - <<EOF\nfix: x\nEOF',
  "git commit -m \"$(cat <<'EOF'\nfix: it's a > b\nEOF\n)\"",
  "gh pr create --title t --body-file - <<'EOF'\nbody > text\nEOF",
  "gh issue comment 1 --body-file - <<'EOF'\nx\nEOF",
  'gh api repos/o/r/issues --input - <<EOF\n{}\nEOF',
  'cat <<EOF\njust print\nEOF',
  // E2: 在るファイルを読む
  'gh pr create --body-file body.md',
  'gh issue comment 1 -F body.md',
  'gh api x --input payload.json',
  // E3: 捨てる先と記述子の付け替え
  'pnpm build > /dev/null 2>&1',
  'pnpm build 2> /dev/null',
  'pnpm build &> /dev/null',
  'pnpm build > /dev/null',
  'echo err >&2',
  'echo err > /dev/stderr',
  'pnpm test 2>&1 | tail -n 50',
  'git commit -F - <<EOF 2>/dev/null\nx\nEOF',
  // E4: 書式・生成の道具
  'prettier --write src/a.ts',
  'eslint --fix src/a.ts',
  'pnpm build',
  'pnpm install',
  'git add -A && git commit -m x',
  'gh pr view 1 --json body',
  // E5: Write で置いたスクリプトを走らせる
  'node scripts/run.mjs',
  'python3 scripts/run.py',
  'bash scripts/run.sh',
  'python3 -m pytest',
  // E6: 書き込みの語を含まないインタプリタのコード
  "node -e 'console.log(1)'",
  "python3 -c 'import json; print(json.dumps({}))'",
  'python3 -c "print(open(\'f\').read())"',
  "node -p 'process.version'",
  "perl -e 'print 1'",
  'echo "{}" | python3 -c "import sys, json; json.load(sys.stdin)"',
  // E7: 中身を書く形ではない
  'cp a b',
  'mv a b',
  'mkdir -p d',
  'touch f',
  'rm -f f',
  'ln -s a b',
  // E8: 引用の中の > と <<
  'gh pr create --body "a > b"',
  "echo '<<EOF'",
  'echo "x >> y" | grep x',
  "grep -n 'a > b' f",
  "awk '$1>3' f",
  "sed -n 's/a/b/p' f",
  // 比較・算術の > は演算子ではあるがリダイレクトではない
  'echo $((2>1))',
  'if [[ a > b ]]; then echo x; fi',
  // コメントの中
  'echo hi # > f',
  // 空
  '',
  '   ',
];

describe('inspectBashFileWrite: 断る形（F1〜F4）', () => {
  for (const command of F1) {
    it(`F1: ${JSON.stringify(command)}`, () => {
      expect(formOf(command)).toBe('heredoc-file-write');
    });
  }
  for (const command of F2) {
    it(`F2: ${JSON.stringify(command)}`, () => {
      expect(formOf(command)).toBe('in-place-edit');
    });
  }
  for (const command of F3) {
    it(`F3: ${JSON.stringify(command)}`, () => {
      expect(formOf(command)).toBe('inline-interpreter-write');
    });
  }
  for (const command of F4) {
    it(`F4: ${JSON.stringify(command)}`, () => {
      expect(formOf(command)).toBe('output-redirect');
    });
  }
});

describe('inspectBashFileWrite: 断らない形（E1〜E8）', () => {
  for (const command of PASS) {
    it(`通す: ${JSON.stringify(command)}`, () => {
      expect(formOf(command)).toBeUndefined();
    });
  }
});

describe('inspectBashFileWrite: 引用の外・heredoc の本文の外だけを見る', () => {
  it('heredoc の本文の中の > や <<EOF や sed -i は当たらない', () => {
    const command =
      "git commit -F - <<'EOF'\nfix: sed -i is bad\n\n  cat > f <<EOF\n  python3 -c \"open('f','w')\"\nEOF";
    expect(formOf(command)).toBeUndefined();
  });

  it('heredoc の本文にアポストロフィが在っても、後ろの本物のリダイレクトは見える', () => {
    expect(formOf("cat <<'EOF'\nit's fine\nEOF\npnpm test > out.log")).toBe('output-redirect');
  });

  it('引用の中の sed -i や > は当たらず、同じ行の外の > は当たる', () => {
    expect(formOf("echo 'sed -i x > y'")).toBeUndefined();
    expect(formOf("echo 'sed -i x > y' > f")).toBe('output-redirect');
  });

  it('改行で区切られた後ろの行の形も見る', () => {
    expect(formOf("echo a\nsed -i 's/a/b/' f")).toBe('in-place-edit');
  });

  it('$(…) の中の形も見る', () => {
    expect(formOf('x=$(cat > f <<EOF\nz\nEOF\n)')).toBe('heredoc-file-write');
  });
});

describe('inspectBashFileWrite: 理由文は代わりの道具を示す', () => {
  it('F1 は Write / Edit を示す', () => {
    const verdict = inspectBashFileWrite('cat > f <<EOF\nx\nEOF');
    expect(verdict.blocked && verdict.reason).toContain('Write');
    expect(verdict.blocked && verdict.reason).toContain('Edit');
    expect(verdict.blocked && verdict.reason).toContain('形=F1');
  });

  it('F2 は Edit を示す', () => {
    const verdict = inspectBashFileWrite("sed -i 's/a/b/' f");
    expect(verdict.blocked && verdict.reason).toContain('Edit');
  });

  it('F3 は Write で置いたスクリプトを走らせる道を示す', () => {
    const verdict = inspectBashFileWrite("python3 -c \"open('f','w')\"");
    expect(verdict.blocked && verdict.reason).toContain('Write');
    expect(verdict.blocked && verdict.reason).toContain('node <file>');
  });

  it('F4 は tail -n を示す', () => {
    const verdict = inspectBashFileWrite('pnpm test > out.log');
    expect(verdict.blocked && verdict.reason).toContain('| tail -n 50');
  });

  it('どの形も、迂回してやり直さないよう告げる', () => {
    for (const command of [...F1, ...F2, ...F3, ...F4]) {
      const verdict = inspectBashFileWrite(command);
      expect(verdict.blocked && verdict.reason).toContain('迂回してやり直さない');
    }
  });
});

describe('resolveBashFileWriteGuardMode（#4348）', () => {
  it('未設定・空・空白は既定（off）', () => {
    expect(DEFAULT_BASH_FILE_WRITE_GUARD).toBe('off');
    expect(resolveBashFileWriteGuardMode({})).toBe('off');
    expect(resolveBashFileWriteGuardMode({ [BASH_FILE_WRITE_GUARD_ENV]: ' ' })).toBe('off');
  });

  it('off / deny をそのまま読む', () => {
    expect(resolveBashFileWriteGuardMode({ [BASH_FILE_WRITE_GUARD_ENV]: ' deny ' })).toBe('deny');
    expect(resolveBashFileWriteGuardMode({ [BASH_FILE_WRITE_GUARD_ENV]: 'off' })).toBe('off');
  });

  it('綴り違いは黙って既定へ倒さず落とす', () => {
    expect(() => resolveBashFileWriteGuardMode({ [BASH_FILE_WRITE_GUARD_ENV]: 'ask' })).toThrow(
      /ALTEROID_BASH_FILE_WRITE_GUARD の値が不正: ask（使えるのは off \/ deny。既定は off）/,
    );
  });
});
