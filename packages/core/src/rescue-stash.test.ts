import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { RescueMemory, runRescue } from './rescue-ref.js';
import type { ProcessSpawnFn } from './unpushed-work.js';
import {
  newRescueStashCycle,
  RescueStashMemory,
  RESCUE_STASH_FILE_MAX_BYTES,
  stashUntrackedFiles,
  type RescueStashCycle,
} from './rescue-stash.js';

const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';

describe('未追跡のファイルの預かり（runner 側。#4863）', () => {
  let root: string;
  let repo: string;
  let staged: string;
  let memory: RescueStashMemory;
  const managerId = 'mgr-stash-0001';

  const run = (
    names: string[],
    extra: {
      final?: boolean;
      cycle?: RescueStashCycle;
      namesPerCycle?: number;
      credentialEnv?: NodeJS.ProcessEnv;
    } = {},
  ) =>
    stashUntrackedFiles(repo, names, {
      managerId,
      stagedRoot: staged,
      expectedUid: process.getuid?.(),
      secretEnv: {},
      credentialEnv: extra.credentialEnv ?? {},
      memory,
      cycle: extra.cycle ?? newRescueStashCycle(),
      ...(extra.final === true ? { final: true } : {}),
      ...(extra.namesPerCycle === undefined ? {} : { namesPerCycle: extra.namesPerCycle }),
    });

  beforeEach(async () => {
    root = await makeTempDir('rescue-stash-test-');
    repo = path.join(root, 'repo');
    staged = path.join(root, 'staged');
    await mkdir(repo);
    memory = new RescueStashMemory();
  });

  it('安定してから預ける: 1回目は待ち、(size, mtime) が同じ2回目に預け、元のファイルは消さない', async () => {
    await writeFile(path.join(repo, 'art.png'), 'pixels');
    const first = await run(['art.png']);
    expect(first).toEqual({ files: [], skipped: [] });
    const second = await run(['art.png']);
    expect(second.files).toHaveLength(1);
    const file = second.files[0]!;
    expect(file.path).toBe('art.png');
    expect(file.size).toBe(6);
    const copy = path.join(staged, managerId, file.fileId);
    expect(await readFile(copy, 'utf8')).toBe('pixels');
    expect((await stat(copy)).mode & 0o777).toBe(0o400);
    expect(await readFile(path.join(repo, 'art.png'), 'utf8')).toBe('pixels');
  });

  it('書きかけ（周期の間に大きさか mtime が変わった）は預けず、止まってから預ける', async () => {
    const file = path.join(repo, 'a.txt');
    await writeFile(file, 'one');
    await run(['a.txt']);
    await writeFile(file, 'one two');
    expect((await run(['a.txt'])).files).toHaveLength(0);
    expect((await run(['a.txt'])).files).toHaveLength(1);
  });

  it('最後の回は安定を待たずに預ける', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'x');
    const result = await run(['a.txt'], { final: true });
    expect(result.files).toHaveLength(1);
  });

  it('前に預けたものと同じ中身は送らず、運び直しの周期（forgetSent）で送り直す。中身が変われば送る', async () => {
    const file = path.join(repo, 'a.txt');
    await writeFile(file, 'same');
    await run(['a.txt']);
    expect((await run(['a.txt'])).files).toHaveLength(1);
    expect((await run(['a.txt'])).files).toHaveLength(0);
    // 中身は同じで mtime だけ変わった: sha256 が同じなので送らない
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    await run(['a.txt']);
    expect((await run(['a.txt'])).files).toHaveLength(0);
    memory.forgetSent();
    expect((await run(['a.txt'])).files).toHaveLength(1);
    await writeFile(file, 'changed');
    await run(['a.txt']);
    expect((await run(['a.txt'])).files).toHaveLength(1);
  });

  it('1ファイルの上限（25 MiB）を超えたら too-large、空は empty。同じ断りは繰り返し知らせない', async () => {
    await writeFile(path.join(repo, 'big.bin'), Buffer.alloc(RESCUE_STASH_FILE_MAX_BYTES + 1, 1));
    await writeFile(path.join(repo, 'empty.txt'), '');
    const first = await run(['big.bin', 'empty.txt'], { final: true });
    expect(first.files).toHaveLength(0);
    expect(first.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
      ['big.bin', 'too-large'],
      ['empty.txt', 'empty'],
    ]);
    expect((await run(['big.bin', 'empty.txt'], { final: true })).skipped).toEqual([]);
  });

  it('1周期の予算を超えた分は cycle-budget として知らせ、次の周期で預ける', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'aaaa');
    await writeFile(path.join(repo, 'b.txt'), 'bbbb');
    const cycle: RescueStashCycle = { bytesLeft: 5 };
    const first = await run(['a.txt', 'b.txt'], { final: true, cycle });
    expect(first.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(first.skipped).toEqual([{ path: 'b.txt', reason: 'cycle-budget' }]);
    const second = await run(['a.txt', 'b.txt'], { final: true });
    expect(second.files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('名前の上限は中身を読みに進む名前だけに掛かる: 先頭側が送り済みでも後ろの名前は次の周期で預かる（#4874）', async () => {
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    for (const name of names) await writeFile(path.join(repo, name), name);
    // 上限 2: 1周期目は a・b を預け、c・d は残りとして数えて知らせる
    const first = await run(names, { final: true, namesPerCycle: 2 });
    expect(first.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0]!.path).toBe('(省略)');
    expect(first.skipped[0]!.reason).toContain('ほか 2 件');
    // 2周期目: a・b は送り済みの記憶で飛ばされ上限に数えられず、c・d が預かれる
    const second = await run(names, { final: true, namesPerCycle: 2 });
    expect(second.files.map((f) => f.path)).toEqual(['c.txt', 'd.txt']);
    expect(second.skipped).toEqual([]);
  });

  it('symlink・ディレクトリは not-regular。symlink の先は読まない', async () => {
    await writeFile(path.join(root, 'outside.txt'), 'outside');
    await symlink(path.join(root, 'outside.txt'), path.join(repo, 'link.txt'));
    await mkdir(path.join(repo, 'dir'));
    const result = await run(['link.txt', 'dir'], { final: true });
    expect(result.files).toEqual([]);
    expect(result.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
      ['dir', 'not-regular'],
      ['link.txt', 'not-regular'],
    ]);
    expect(await readdir(path.join(staged, managerId))).toEqual([]);
  });

  it('鍵らしい文字列を含むテキストは secret-like（規則の名前だけ。値は出さない）', async () => {
    await writeFile(path.join(repo, 'notes.txt'), `key=${AWS_KEY}\n`);
    const result = await run(['notes.txt'], { final: true });
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'notes.txt', reason: 'secret-like', patterns: ['aws-access-key'] },
    ]);
    expect(JSON.stringify(result)).not.toContain(AWS_KEY);
  });

  it('バイナリ（NUL を含む）は固有の接頭辞の規則だけ見る: 形だけの規則には当てず、接頭辞つきには当てる', async () => {
    const plain = Buffer.concat([Buffer.from([0x89, 0x50, 0, 1]), Buffer.from('user:pw@host')]);
    await writeFile(path.join(repo, 'img.png'), plain);
    await writeFile(
      path.join(repo, 'leak.bin'),
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(AWS_KEY)]),
    );
    const result = await run(['img.png', 'leak.bin'], { final: true });
    expect(result.files.map((f) => f.path)).toEqual(['img.png']);
    expect(result.skipped).toEqual([
      { path: 'leak.bin', reason: 'secret-like', patterns: ['aws-access-key'] },
    ]);
  });

  it('資格の置き場の配下と、*_FILE の環境変数が指すファイルは credential', async () => {
    const credDir = path.join(root, 'creds');
    await mkdir(credDir);
    // 作業ツリーの中に資格の置き場がある形（置き場の配下）
    const inside = path.join(repo, 'creds');
    await symlink(credDir, inside);
    await writeFile(path.join(credDir, 'token'), 'hello');
    await writeFile(path.join(repo, 'secret.txt'), 'plain text');
    const result = await run(['creds/token', 'secret.txt'], {
      final: true,
      credentialEnv: {
        ALTEROID_CREDENTIAL_DIR: credDir,
        SOME_KEY_FILE: path.join(repo, 'secret.txt'),
      },
    });
    expect(result.files).toEqual([]);
    expect(result.skipped.map((s) => [s.path, s.reason]).sort()).toEqual([
      ['creds/token', 'credential'],
      ['secret.txt', 'credential'],
    ]);
  });

  it('作業ツリーの外を指す名前（..・絶対パス）は無視する', async () => {
    await writeFile(path.join(root, 'outside.txt'), 'outside');
    const result = await run(['../outside.txt', path.join(root, 'outside.txt')], { final: true });
    expect(result).toEqual({ files: [], skipped: [] });
  });

  it('runRescue から呼ばれる: 退避 ref を push できない（資格無し）回でも預け、最後の回は安定を待たない', async () => {
    const env: Record<string, string> = {
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
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
    await writeFile(path.join(repo, 'drawing.png'), 'png-bytes');
    const rescueMemory = new RescueMemory();
    const seen: { worktree: string; paths: string[] }[] = [];
    const go = (final: boolean) =>
      runRescue(repo, {
        managerId,
        spawn: realSpawn,
        env,
        memory: rescueMemory,
        tmpRootDir: path.join(root, 'no-tmp'),
        stash: {
          stagedRoot: staged,
          expectedUid: process.getuid?.(),
          secretEnv: {},
          credentialEnv: {},
          ...(final ? { final: true } : {}),
          onResult: (worktree, result) =>
            seen.push({ worktree, paths: result.files.map((f) => f.path) }),
        },
      });
    await go(false);
    expect(seen).toEqual([]);
    await go(true);
    expect(seen).toEqual([{ worktree: '.', paths: ['drawing.png'] }]);
  });
});
