import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

describe('listGitScannableFiles（Issue #1817）', () => {
  async function makeRepoWithUntrackedFile(): Promise<string> {
    const dir = await makeTempDir('git-scannable-files-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'tracked.txt'), 'tracked content\n');
    git('add', '-A');
    git('commit', '-qm', 'init: one tracked file');
    await writeFile(join(dir, 'new-untracked.txt'), 'new untracked content\n');
    return dir;
  }

  it('🔴→🟢 の対比: 旧い形（`git ls-files -z`、cached のみ）は未追跡ファイルを取りこぼす', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const oldForm = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.txt');
    expect(oldForm).toContain('tracked.txt');
  });

  it('直した形: 追跡済み・未追跡の両方を返す', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const files = listGitScannableFiles({ cwd: dir }) as string[];
    expect(files).toContain('tracked.txt');
    expect(files).toContain('new-untracked.txt');
  });

  it('`.gitignore` に一致する未追跡ファイルは対象に入れない', async () => {
    const dir = await makeRepoWithUntrackedFile();
    await mkdir(join(dir, 'ignored-dir'), { recursive: true });
    await writeFile(join(dir, 'ignored-dir', 'scratch.txt'), 'scratch\n');
    await writeFile(join(dir, '.gitignore'), 'ignored-dir/\n');

    const files = listGitScannableFiles({ cwd: dir }) as string[];
    expect(files).not.toContain('ignored-dir/scratch.txt');
    expect(files).toContain('.gitignore');
  });

  it('pathspec で絞り込める（`.claude` 配下だけ、のような呼び出し元向け）', async () => {
    const dir = await makeRepoWithUntrackedFile();
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'inside.txt'), 'inside\n');

    const files = listGitScannableFiles({ cwd: dir, pathspec: ['sub'] }) as string[];
    expect(files).toEqual(['sub/inside.txt']);
  });

  it('対象が1件も無いディレクトリでは空配列を返す（git repo 自体は要る）', async () => {
    const dir = await makeTempDir('git-scannable-files-empty-');
    execFileSync('git', ['init', '-q'], { cwd: dir, env: gitChildEnv() });
    const files = listGitScannableFiles({ cwd: dir }) as string[];
    expect(files).toEqual([]);
  });
});
