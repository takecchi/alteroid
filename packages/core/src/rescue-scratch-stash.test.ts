import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { RescueMemory, runRescue } from './rescue-ref.js';
import type { ScratchDirEntry, ScratchReaddirFn } from './rescue-scratch-files.js';
import type { RescueStashResult } from './rescue-stash.js';
import type { ProcessSpawnFn } from './unpushed-work.js';

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const realSpawn: ProcessSpawnFn = (o) =>
  spawn(o.command, o.args, {
    ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
    env: o.env as NodeJS.ProcessEnv,
    signal: o.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// 担当の作業場の名前の決まり（`/tmp/mgr-<識別子の先頭>` と `-*`）。試験は `os.tmpdir()` の下の専用の dir を使い、本物の /tmp/mgr-* へは書かない
const managerId = 'mgr-abcd1234-0000-0000-0000-000000000000';

describe('担当の作業場の git でない置き場の預かり（#5255）', () => {
  let root: string;
  let cwd: string;
  let tmpRootDir: string;
  let bench: string;
  let staged: string;
  let memory: RescueMemory;
  let seen: { worktree: string; result: RescueStashResult }[];

  const go = (
    options: { final?: boolean; scratchReaddirFn?: ScratchReaddirFn } = {},
  ): Promise<unknown> =>
    runRescue(cwd, {
      managerId,
      spawn: realSpawn,
      env: GIT_ENV,
      memory,
      tmpRootDir,
      ...(options.scratchReaddirFn === undefined
        ? {}
        : { scratchReaddirFn: options.scratchReaddirFn }),
      stash: {
        stagedRoot: staged,
        expectedUid: process.getuid?.(),
        secretEnv: {},
        credentialEnv: {},
        ...(options.final === true ? { final: true } : {}),
        onResult: (worktree, result) => seen.push({ worktree, result }),
      },
    });
  const pathsOf = (worktree: string): string[] =>
    seen
      .filter((s) => s.worktree === worktree)
      .flatMap((s) => s.result.files.map((f) => f.path))
      .sort();

  beforeEach(async () => {
    root = await makeTempDir('rescue-scratch-test-');
    cwd = path.join(root, 'work');
    tmpRootDir = path.join(root, 'tmp');
    bench = path.join(tmpRootDir, 'mgr-abcd1234-bench');
    staged = path.join(root, 'staged');
    await mkdir(cwd, { recursive: true });
    await mkdir(bench, { recursive: true });
    memory = new RescueMemory();
    seen = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('git でない置き場のファイルを預け、worktree の名前はその置き場の位置にする', async () => {
    await mkdir(path.join(bench, 'tools'));
    await writeFile(path.join(bench, 'tools', 'measure.mjs'), 'measure');
    await writeFile(path.join(bench, 'request.md'), 'ask astra');
    await go();
    expect(seen).toEqual([]);
    await go();
    expect(seen.map((s) => s.worktree)).toEqual([bench]);
    expect(pathsOf(bench)).toEqual(['request.md', path.join('tools', 'measure.mjs')]);
    const file = seen[0]?.result.files.find((f) => f.path === 'request.md');
    expect(await readFile(path.join(staged, managerId, file?.fileId ?? ''), 'utf8')).toBe(
      'ask astra',
    );
    // 元は消さない
    expect(await readFile(path.join(bench, 'request.md'), 'utf8')).toBe('ask astra');
  });

  it('置き場の中の git の作業ツリーの中は二重に預けない（作業ツリーの経路だけ）', async () => {
    await writeFile(path.join(bench, 'script.sh'), 'echo');
    const inner = path.join(bench, 'repo');
    await mkdir(inner);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inner, env: GIT_ENV });
    await writeFile(path.join(inner, 'draft.txt'), 'draft');
    await go({ final: true });
    expect(pathsOf(bench)).toEqual(['script.sh']);
    expect(pathsOf(inner)).toEqual(['draft.txt']);
    expect(seen.flatMap((s) => s.result.files.map((f) => f.path))).toHaveLength(2);
  });

  it('置き場の根が git の作業ツリーそのものなら、作業ツリーの経路だけで1度だけ預ける', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: bench, env: GIT_ENV });
    await writeFile(path.join(bench, 'draft.txt'), 'draft');
    await go({ final: true });
    expect(seen.map((s) => s.worktree)).toEqual([bench]);
    expect(pathsOf(bench)).toEqual(['draft.txt']);
  });

  it('除外名の中と symlink は預けない', async () => {
    await mkdir(path.join(bench, 'node_modules'));
    await writeFile(path.join(bench, 'node_modules', 'dep.js'), 'dep');
    await mkdir(path.join(bench, '.cache'));
    await writeFile(path.join(bench, '.cache', 'c'), 'cache');
    await writeFile(path.join(bench, 'real.txt'), 'real');
    await symlink(path.join(bench, 'real.txt'), path.join(bench, 'alias.txt'));
    await go({ final: true });
    expect(pathsOf(bench)).toEqual(['real.txt']);
    expect(seen.flatMap((s) => s.result.skipped)).toEqual([]);
  });

  it('件数の上限を超えた分は、預けなかったと知らせ、同じ内容は次の周期で繰り返さない', async () => {
    const many: ScratchDirEntry[] = Array.from({ length: 2001 }, (_, i) => ({
      name: `f${String(i).padStart(4, '0')}`,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    }));
    const scratchReaddirFn: ScratchReaddirFn = async (dir) => {
      if (dir !== bench) throw new Error('ENOENT');
      return many;
    };
    await go({ scratchReaddirFn });
    const first = seen.flatMap((s) => s.result.skipped).filter((s) => s.path === '(省略)');
    expect(first).toHaveLength(1);
    expect(first[0]?.reason).toContain('2000 件');
    expect(seen[0]?.worktree).toBe(bench);
    seen.length = 0;
    await go({ scratchReaddirFn });
    expect(
      seen.flatMap((s) => s.result.skipped).filter((s) => s.reason.includes('2000 件')),
    ).toEqual([]);
  });

  it('深さの上限を超えたディレクトリは、預けなかったと知らせる', async () => {
    let dir = bench;
    for (let i = 0; i < 13; i += 1) {
      dir = path.join(dir, 'd');
      await mkdir(dir);
    }
    await writeFile(path.join(dir, 'deep.txt'), 'deep');
    await go({ final: true });
    expect(pathsOf(bench)).toEqual([]);
    const skipped = seen.flatMap((s) => s.result.skipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain('深さの上限 12');
  });

  it('畳む直前（final）は安定を待たずに預ける', async () => {
    await writeFile(path.join(bench, 'last.txt'), 'last words');
    await go({ final: true });
    expect(pathsOf(bench)).toEqual(['last.txt']);
  });

  it('2周期目に記憶が保たれ、安定の判定が通る（置き場の根を retain する）。書き換わったら通らない', async () => {
    const file = path.join(bench, 'wip.txt');
    await writeFile(file, 'v1');
    await go();
    expect(seen).toEqual([]);
    // 書きかけ: 1周期目と大きさが変わったら、この周期は預けない
    await writeFile(file, 'v1-longer');
    await go();
    expect(seen).toEqual([]);
    await go();
    expect(pathsOf(bench)).toEqual(['wip.txt']);
    // 預けた後は、変わらないものを繰り返し預けない
    seen.length = 0;
    await go();
    expect(seen).toEqual([]);
  });

  it('置き場が消えたら記憶を捨て、同じ名前が戻っても安定を待ち直す', async () => {
    const file = path.join(bench, 'a.txt');
    // 大きさも mtime も同じにする: 記憶が残っていれば、戻った直後の周期で預けてしまう
    const when = new Date('2026-01-01T00:00:00Z');
    await writeFile(file, 'one');
    await utimes(file, when, when);
    await go();
    await rm(bench, { recursive: true });
    await go();
    await mkdir(bench);
    await writeFile(file, 'one');
    await utimes(file, when, when);
    await go();
    expect(seen).toEqual([]);
    await go();
    expect(pathsOf(bench)).toEqual(['a.txt']);
  });

  it('担当の作業場でない置き場（他の担当・共有）は預けない', async () => {
    const other = path.join(tmpRootDir, 'mgr-ffff0000-bench');
    await mkdir(other);
    await writeFile(path.join(other, 'theirs.txt'), 'theirs');
    const plain = path.join(tmpRootDir, 'bench');
    await mkdir(plain);
    await writeFile(path.join(plain, 'shared.txt'), 'shared');
    await go({ final: true });
    expect(seen).toEqual([]);
  });

  it('stash が無い呼び出しでは何も預けない', async () => {
    await writeFile(path.join(bench, 'x.txt'), 'x');
    await runRescue(cwd, {
      managerId,
      spawn: realSpawn,
      env: GIT_ENV,
      memory,
      tmpRootDir,
    });
    expect(seen).toEqual([]);
  });

  it('秘密らしいファイルは、置き場でも預けず理由を知らせる', async () => {
    await writeFile(path.join(bench, 'keys.txt'), 'AKIAABCDEFGHIJKLMNOP');
    await go({ final: true });
    expect(pathsOf(bench)).toEqual([]);
    const skipped = seen.flatMap((s) => s.result.skipped);
    expect(skipped.map((s) => [s.path, s.reason])).toEqual([['keys.txt', 'secret-like']]);
  });
});
