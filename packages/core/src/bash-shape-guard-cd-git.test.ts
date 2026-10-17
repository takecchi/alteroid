import { describe, expect, it } from 'vitest';

import { BASH_SHAPE_CONTINUE_NOTE, inspectBashShape } from './bash-shape-guard.js';

describe('cd の後ろに git以外のコマンドを重ねる形は cd-chain で止める（#5017）', () => {
  it.each(['cd x && make', 'cd x; ls', 'cd x | cat', 'cd x && pnpm test', '(cd x && make)'])(
    '%j は cd-chain で止め、コマンドの側で場所を指すよう勧めて続けてよいと締める',
    (command) => {
      const v = inspectBashShape(command);
      expect(v.blocked && v.form).toBe('cd-chain');
      if (!v.blocked) return;
      expect(v.reason).toContain('`cd` を外して');
      expect(v.reason).toContain('pnpm -C <絶対パス>');
      expect(v.reason).toContain('make -C <絶対パス>');
      expect(v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
    },
  );

  it('git が続く形は cd-git のまま（git 専用の理由を残す）', () => {
    const v = inspectBashShape('cd x && make && git status');
    expect(v.blocked && v.form).toBe('cd-git');
  });
});

describe('cd と git を1回の Bash に重ねる形は止める（#4993）', () => {
  it.each([
    'cd x && git status',
    'cd /tmp/w; git log',
    '(cd x && git diff)',
    'cd x && pnpm i && git commit -m a',
    'cd x || git status',
    'cd x && git -C y status',
  ])('%j は cd-git で止め、git -C を勧めて続けてよいと締める', (command) => {
    const v = inspectBashShape(command);
    expect(v.blocked && v.form).toBe('cd-git');
    if (!v.blocked) return;
    expect(v.reason).toContain('git -C <絶対パス>');
    expect(v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
  });

  it('もっとはっきりした形（git reset など）があれば、そちらの理由を返す', () => {
    const v = inspectBashShape('cd x && git reset --hard');
    expect(v.blocked && v.form).toBe('git-reset');
  });

  it.each([
    'git -C x status',
    'cd x',
    'cd /x',
    'git status && cd x',
    'echo "cd x && git y"',
    "echo 'cd x; git y'",
    'ls # cd x && git status',
  ])('%j は止めない', (command) => {
    expect(inspectBashShape(command)).toEqual({ blocked: false });
  });
});
