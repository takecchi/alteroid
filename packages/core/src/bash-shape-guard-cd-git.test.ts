import { describe, expect, it } from 'vitest';

import { BASH_SHAPE_CONTINUE_NOTE, inspectBashShape } from './bash-shape-guard.js';

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
    'cd x && ls',
    'cd x',
    'git status && cd x',
    'echo "cd x && git y"',
    "echo 'cd x; git y'",
    'ls # cd x && git status',
  ])('%j は止めない', (command) => {
    expect(inspectBashShape(command)).toEqual({ blocked: false });
  });
});
