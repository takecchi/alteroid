import { describe, expect, it } from 'vitest';

import {
  BASH_SHAPE_CONTINUE_NOTE,
  bashShapePromptLines,
  inspectBashShape,
} from './bash-shape-guard.js';

describe('衝突を片側の版へ丸ごと寄せる形は git-take-side で止める', () => {
  it.each([
    'git merge -X theirs origin/main',
    'git merge -Xours origin/main',
    'git merge --strategy-option=theirs origin/main',
    'git merge --strategy-option ours origin/main',
    'git merge -s ours origin/main',
    'git merge --strategy=ours origin/main',
    'git -C /tmp/w merge -X theirs origin/main',
    'git pull -X theirs origin main',
    // `-Xtheirs` の `r` を rebase の `-r` と読まず、片側寄せとして止める
    'git pull -Xtheirs origin main',
    'git cherry-pick -X theirs abc123',
    'git revert --strategy-option=ours abc123',
    'git checkout --theirs src/a.ts',
    'git checkout --ours -- src/a.ts',
    'git restore --theirs src/a.ts',
    'git restore --ours --worktree src/a.ts',
  ])('%j は止め、塊ごとに Read と Edit で解くよう勧めて続けてよいと締める', (command) => {
    const v = inspectBashShape(command);
    expect(v.blocked && v.form).toBe('git-take-side');
    if (!v.blocked) return;
    expect(v.reason).toContain('Edit で解く');
    expect(v.reason).toContain('依頼者へ確かめる');
    expect(v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
  });

  it.each([
    'git merge origin/main',
    'git merge -s recursive origin/main',
    'git merge -X patience origin/main',
    'git merge --no-ff -m "theirs" origin/main',
    'git cherry-pick -s abc123',
    'git revert -s abc123',
    'git checkout main',
    'git checkout -- src/theirs.ts',
    'git restore --staged src/a.ts',
    'git log --oneline -n 5 -- ours',
    'echo git merge -X theirs',
  ])('%j は通す', (command) => {
    expect(inspectBashShape(command).blocked).toBe(false);
  });
});

describe('持ち主の違う作業場をまたぐ mv は mv-across-workspaces で止める', () => {
  it.each([
    'mv /tmp/mgr-e5e9e958/heosterra /tmp/mgr-197b1f1c/heosterra',
    'mv -f /tmp/mgr-e5e9e958/repo /tmp/mgr-197b1f1c-wt1/',
    'mv -t /tmp/mgr-197b1f1c /tmp/mgr-e5e9e958/repo',
    'mv --target-directory=/tmp/mgr-197b1f1c /tmp/mgr-e5e9e958/repo',
    'mv /workspace/mgr-e5e9e958/repo /tmp/mgr-197b1f1c/repo',
    'mv -- /tmp/mgr-e5e9e958/repo /tmp/mgr-197b1f1c/repo',
  ])(
    '%j は止め、元を残して push と clone・cp で取り出すよう勧めて続けてよいと締める',
    (command) => {
      const v = inspectBashShape(command);
      expect(v.blocked && v.form).toBe('mv-across-workspaces');
      if (!v.blocked) return;
      expect(v.reason).toContain('元の作業ツリーは動かさずに残し');
      expect(v.reason).toContain('push');
      expect(v.reason).toContain('`cp`');
      expect(v.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
    },
  );

  it.each([
    'mv /tmp/mgr-197b1f1c/a.txt /tmp/mgr-197b1f1c/b.txt',
    'mv /tmp/mgr-197b1f1c/repo /tmp/mgr-197b1f1c-wt1/repo',
    'mv src/a.ts src/b.ts',
    'mv /tmp/mgr-197b1f1c/out.log /tmp/other/out.log',
    'mv -S .bak /tmp/mgr-197b1f1c/a /tmp/mgr-197b1f1c/b',
    'echo mv /tmp/mgr-e5e9e958/repo /tmp/mgr-197b1f1c/repo',
  ])('%j は通す', (command) => {
    expect(inspectBashShape(command).blocked).toBe(false);
  });
});

describe('足した形はプロンプトの一覧にも載る', () => {
  it('一覧に片側寄せと作業場をまたぐ mv の行がある', () => {
    const lines = bashShapePromptLines();
    expect(lines).toContain('`git merge -X theirs`');
    expect(lines).toContain('をまたぐ `mv`');
  });
});
