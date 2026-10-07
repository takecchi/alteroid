import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  compareVerifiedHead,
  // @ts-expect-error -- 素の .mjs
} from './check-verified-head-core.mjs';
import {
  fingerprint,
  recordFor,
  writeTreeFor,
  // @ts-expect-error -- 同上
} from './verify-core.mjs';

describe('PR #1774 再現: 追跡+ignore のファイルで fingerprint と writeTreeFor の範囲がずれる', () => {
  async function makeRepoWithTrackedIgnoredFile(): Promise<string> {
    const dir = await makeTempDir('t3-check-verified-head-repro-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(join(dir, 'tracked-but-ignored.txt'), 'original content\n');
    git('add', '-A');
    git('commit', '-qm', 'init: track the file before it is ignored');
    await writeFile(join(dir, '.gitignore'), 'tracked-but-ignored.txt\n');
    git('add', '-A');
    git('commit', '-qm', 'add .gitignore matching the already-tracked file');
    return dir;
  }

  it('前提確認: git ls-files -c は無視パターンに関わらず追跡ファイルを見せ続ける', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    });
    expect(out.split('\n').filter(Boolean)).toContain('tracked-but-ignored.txt');
  });

  it('fingerprint() は追跡+ignore ファイルを範囲に含む', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const fpWith = fingerprint(dir) as string;

    await writeFile(join(dir, 'tracked-but-ignored.txt'), 'DIFFERENT content\n');
    const fpAfterEdit = fingerprint(dir) as string;

    expect(fpAfterEdit).not.toBe(fpWith);
  });

  it('🔴 writeTreeFor() が作る tree には追跡+ignore ファイルが1つも現れない', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const tree = writeTreeFor(dir) as string;
    expect(tree).not.toBeNull();

    const lsTree = execFileSync('git', ['ls-tree', '-r', '--name-only', tree], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    });
    const paths = lsTree.split('\n').filter(Boolean);

    expect(paths).toContain('tracked-but-ignored.txt');
  });

  it('🔴 帰結: verify直後に何も変えずcommitしたHEADが「不一致」になる（歯1の前提が崩れる）', async () => {
    const dir = await makeRepoWithTrackedIgnoredFile();
    const recordPath = join(dir, '.git', 'alteroid-verify.json');

    const fp = fingerprint(dir) as string;
    const tree = writeTreeFor(dir) as string;
    writeFileSync(
      recordPath,
      JSON.stringify(recordFor(fp, new Date('2026-09-27T00:00:00.000Z'), tree), null, 2) + '\n',
    );

    const result = compareVerifiedHead({ repo: dir, rev: 'HEAD', recordPath });

    expect(result.verdict).toBe('match');
  });
});
