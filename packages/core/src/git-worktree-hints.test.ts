import { describe, expect, it } from 'vitest';

import {
  gitDirsFromBashCommand,
  isSameOrInside,
  isUnderManagerScratchDir,
} from './git-worktree-hints.js';

describe('gitDirsFromBashCommand: git を打った場所を取り出す', () => {
  it('git を打った部分の、その時点の場所（フックの cwd）を返す。git を打たなければ返さない', () => {
    expect(gitDirsFromBashCommand('git status', '/tmp/mgr-alt-dev-k/repo')).toEqual([
      '/tmp/mgr-alt-dev-k/repo',
    ]);
    expect(gitDirsFromBashCommand('ls -la', '/tmp/mgr-alt-dev-k/repo')).toEqual([]);
  });

  it('cd の先で打った git はその先。相対の cd はその時点の場所から解く', () => {
    expect(gitDirsFromBashCommand('cd /tmp/role-dir/repo && git push', '/workspace')).toEqual([
      '/tmp/role-dir/repo',
    ]);
    expect(gitDirsFromBashCommand('cd repo/sub && git commit -m x', '/tmp/role-dir')).toEqual([
      '/tmp/role-dir/repo/sub',
    ]);
  });

  it('git -C の先（相対も解く）。値を取る大域オプションを飛ばし、timeout と先頭の NAME=value も外す', () => {
    expect(gitDirsFromBashCommand('git -C /tmp/a/repo status', '/workspace')).toEqual([
      '/tmp/a/repo',
    ]);
    expect(gitDirsFromBashCommand('git -c user.name=x -C repo log', '/tmp/a')).toEqual([
      '/tmp/a/repo',
    ]);
    expect(
      gitDirsFromBashCommand(
        'GIT_OPTIONAL_LOCKS=0 timeout -k 5 60 git -C /tmp/b push',
        '/workspace',
      ),
    ).toEqual(['/tmp/b']);
  });

  it('つないだ形は部分ごとにたどり、重複なしで出た順に返す', () => {
    expect(
      gitDirsFromBashCommand(
        'git -C /tmp/a status ; cd /tmp/b\ngit add . && git commit -m m | cat',
        '/workspace',
      ),
    ).toEqual(['/tmp/a', '/tmp/b']);
  });

  it('解けない cd（変数・~・引用符）の後は場所を足さない。cwd が無い・相対なら素の git も足さない', () => {
    expect(gitDirsFromBashCommand('cd "$WORK" && git push', '/workspace')).toEqual([]);
    expect(gitDirsFromBashCommand('cd ~/repo && git push', '/workspace')).toEqual([]);
    expect(gitDirsFromBashCommand('git status', undefined)).toEqual([]);
    expect(gitDirsFromBashCommand('git status', 'relative/dir')).toEqual([]);
    expect(gitDirsFromBashCommand('git -C /tmp/a status', undefined)).toEqual(['/tmp/a']);
  });
});

describe('作業場の決まりの判定', () => {
  it('isSameOrInside: 同じか中なら真。名前の前方一致では真にしない', () => {
    expect(isSameOrInside('/tmp/a', '/tmp/a')).toBe(true);
    expect(isSameOrInside('/tmp/a/b', '/tmp/a')).toBe(true);
    expect(isSameOrInside('/tmp/ab', '/tmp/a')).toBe(false);
    expect(isSameOrInside('/tmp', '/tmp/a')).toBe(false);
  });

  it('isUnderManagerScratchDir: /tmp/mgr-<16進> の下だけ真。役割名の作業場は偽', () => {
    expect(isUnderManagerScratchDir('/tmp/mgr-65a37e68/repo')).toBe(true);
    expect(isUnderManagerScratchDir('/tmp/mgr-alt-dev-k/repo')).toBe(false);
    expect(isUnderManagerScratchDir('/var/tmp/mgr-65a37e68')).toBe(false);
  });
});
