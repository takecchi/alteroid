import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { RESCUE_MAX_WORKTREES } from './rescue-ref.js';
import { DEFAULT_MAX_WORKTREES, listWorktreeRoots } from './unpushed-work.js';

// 退避の作業ツリーの探索は、共有の cwd より先に、担い手が git を打った作業ツリーと担当の作業場を探す（#4953）

const managerId = 'mgr-4953abcd-0000-0000-0000-000000000000';

let root: string;
let cwd: string;
let tmpRoot: string;

// 列挙は `.git` が在るかだけを見るので、本物の git を起こさずに作業ツリーの形だけを置く
function fakeWorktree(dir: string): string {
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

beforeEach(() => {
  root = makeTempDirSync('alteroid-unpushed-work-order-');
  cwd = join(root, 'shared-cwd');
  tmpRoot = join(root, 'tmp');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
});

describe('作業ツリーの探す順（#4953）', () => {
  it('cwd に枠を超える作業ツリーが在っても、git を打った作業ツリーと担当の作業場が先に載る', async () => {
    for (let i = 0; i < 5; i += 1) fakeWorktree(join(cwd, `other-${String(i)}`));
    const scratch = fakeWorktree(join(tmpRoot, 'mgr-4953abcd', 'w1'));
    const hinted = fakeWorktree(join(root, 'elsewhere', 'repo'));
    mkdirSync(join(hinted, 'sub'), { recursive: true });

    const listed = await listWorktreeRoots(cwd, {
      managerId,
      tmpRootDir: tmpRoot,
      hintDirs: [join(hinted, 'sub')],
      maxWorktrees: 3,
    });

    const roots = listed.worktrees.map((tree) => tree.repoRoot);
    expect(roots).toHaveLength(3);
    expect(roots[0]).toBe(hinted);
    expect(roots[1]).toBe(scratch);
    expect(roots[2]?.startsWith(join(cwd, 'other-'))).toBe(true);
    expect(listed.truncatedAtCount).toBe(3);
  });

  it('枠が先に尽きて cwd を探さなかった回も、cwd が読めなければ読めないと返す', async () => {
    // ファイルを cwd にして、ディレクトリとして読めなくする（権限で塞ぐ形は root で走る器では効かない）
    const fileCwd = join(root, 'not-a-dir');
    writeFileSync(fileCwd, 'x');
    for (let i = 0; i < 3; i += 1) fakeWorktree(join(tmpRoot, 'mgr-4953abcd', `w${String(i)}`));

    const listed = await listWorktreeRoots(fileCwd, {
      managerId,
      tmpRootDir: tmpRoot,
      maxWorktrees: 2,
    });

    expect(listed.worktrees).toEqual([]);
    expect(listed.unreadable).toBeDefined();
  });

  it('退避の上限は、manager_stop の表示の上限から切り離して大きく取る', () => {
    expect(DEFAULT_MAX_WORKTREES).toBe(20);
    expect(RESCUE_MAX_WORKTREES).toBe(40);
  });
});
