import { describe, expect, it } from 'vitest';

import { BASH_SHAPE_CONTINUE_NOTE, inspectBashShape } from './bash-shape-guard.js';

describe('1回の拒否で、重なった形の直し方をまとめて返す', () => {
  it('redirect・cd-chain・chain が重なる呼び出しは、先頭は redirect のまま3つの直し方を返す', () => {
    const v = inspectBashShape('cd X && pnpm install >/dev/null; npx prettier --write f');
    expect(v.blocked && v.form).toBe('redirect');
    if (!v.blocked) return;
    expect(v.reason.startsWith('出力のリダイレクト')).toBe(true);
    expect(v.reason).toContain('他にも:');
    expect(v.reason).toContain('`cd` の後ろに別のコマンドを同じ1回で続ける形');
    expect(v.reason).toContain('`;` で2つ以上のコマンドを繋ぐ形');
    expect(v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
    expect(v.reason.split(BASH_SHAPE_CONTINUE_NOTE).length).toBe(2);
  });

  it('pipe-trim と pipe-masks-exit も、先頭の形のあとに添える', () => {
    const v = inspectBashShape('git commit -m x | tail -3; echo done');
    expect(v.blocked && v.form).toBe('pipe-masks-exit');
    if (!v.blocked) return;
    expect(v.reason).toContain('他にも:');
    expect(v.reason).toContain('`head`・`tail`');
    expect(v.reason).toContain('`;` で2つ以上のコマンドを繋ぐ形');
  });

  it('cd-git が先頭のときは cd-chain を重ねて足さない', () => {
    const v = inspectBashShape('cd /a && git status; echo x');
    expect(v.blocked && v.form).toBe('cd-git');
    if (!v.blocked) return;
    expect(v.reason).toContain('`;` で2つ以上のコマンドを繋ぐ形');
    expect(v.reason).not.toContain('`cd` の後ろに別のコマンドを同じ1回で続ける形');
  });

  it('redirect 系どうしは重ねて足さない', () => {
    const v = inspectBashShape('echo a > f 2>&1');
    expect(v.blocked && v.form).toBe('redirect');
    if (!v.blocked) return;
    expect(v.reason).not.toContain('他にも:');
  });

  it.each([
    ['echo a > f', 'redirect', '出力のリダイレクト'],
    ['cd /a && ls', 'cd-chain', '`cd` の後ろに別のコマンド'],
    ['echo a; echo b', 'chain', '`;` で2つ以上のコマンド'],
    ['git log | head -20', 'pipe-trim', '管の最後の段が `head`・`tail`'],
  ])('単一の形 %j は理由が変わらず、他にもを足さない', (command, form, lead) => {
    const v = inspectBashShape(command);
    expect(v.blocked && v.form).toBe(form);
    if (!v.blocked) return;
    expect(v.reason.startsWith(lead)).toBe(true);
    expect(v.reason).not.toContain('他にも:');
  });

  it('`;` が for の中なら chain を足さない', () => {
    const v = inspectBashShape('for f in a b; do echo $f; done > out.txt');
    expect(v.blocked && v.form).toBe('redirect');
    if (!v.blocked) return;
    expect(v.reason).not.toContain('他にも:');
    expect(v.reason).not.toContain('`;` で2つ以上のコマンドを繋ぐ形');
  });

  it('heredoc が先頭のときは広げない', () => {
    const v = inspectBashShape("cat <<'EOF'\nx\nEOF\n; echo a");
    expect(v.blocked && v.form).toBe('heredoc');
    if (!v.blocked) return;
    expect(v.reason).not.toContain('他にも:');
  });
});
