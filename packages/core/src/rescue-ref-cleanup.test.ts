import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteRescueRef,
  redactRemoteUrl,
  RescueMemory,
  rescueRefName,
  runRescue,
} from './rescue-ref.js';
import type { ProcessSpawnFn } from './unpushed-work.js';

/**
 * 退避 ref の**後始末**（Issue #1266）の runner 側。実 git とローカルの bare で見る
 * （実リポジトリの ref は作らない・消さない）。足場は `rescue-ref.test.ts` と同じ作り。
 */
const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let spawnCount = 0;
const realSpawn: ProcessSpawnFn = (o) => {
  spawnCount += 1;
  return spawn(o.command, o.args, {
    ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
    env: o.env as NodeJS.ProcessEnv,
    signal: o.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

describe('退避 ref の後始末（runner 側。#1266）', () => {
  let root: string;
  let repo: string;
  let bare: string;
  let tmp: string;
  const managerId = 'mgr-abcd1234-0000-0000-0000-000000000000';

  const run = (memory = new RescueMemory()) =>
    runRescue(repo, {
      managerId,
      spawn: realSpawn,
      env: { ...GIT_ENV, GH_TOKEN: 'x' },
      memory,
      tmpRootDir: path.join(root, 'no-tmp'),
    });
  const del = (ref: string, commit: string, remote = bare) =>
    deleteRescueRef({
      spawn: realSpawn,
      env: GIT_ENV,
      remote,
      ref,
      commit,
      tmpRootDir: tmp,
    });
  const refsInBare = (): string => g(bare, 'for-each-ref', 'refs/alteroid-rescue/');

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'rescue-cleanup-test-'));
    repo = path.join(root, 'repo');
    bare = path.join(root, 'origin.git');
    tmp = path.join(root, 'tmp');
    await mkdir(repo);
    await mkdir(tmp);
    g(root, 'init', '-q', '--bare', bare);
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'remote', 'add', 'origin', bare);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-qm', 'first');
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
    spawnCount = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('退避の記録に、送った先（資格を落とした URL）と退避 commit の tree が付く', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'edited\n');
    const [report] = await run();
    expect(report?.pushed?.remote).toBe(bare);
    const commit = report?.pushed?.commit as string;
    expect(report?.pushed?.tree).toBe(g(bare, 'rev-parse', `${commit}^{tree}`).trim());
    expect(report?.pushed?.landedAt).toBeUndefined();
  });

  it('退避の中身が origin の枝に入ったら landedAt が付く（tree の一致）', async () => {
    const memory = new RescueMemory();
    await writeFile(path.join(repo, 'a.txt'), 'edited\n');
    const [first] = await run(memory);
    expect(first?.pushed?.landedAt).toBeUndefined();
    // コミットして push する（作業ツリーの内容は退避 commit の tree と同じになる）。
    g(repo, 'commit', '-qam', 'ship it');
    g(repo, 'push', '-q', 'origin', 'main');
    const [second] = await run(memory);
    expect(second?.pushed?.commit).toBe(first?.pushed?.commit);
    expect(second?.pushed?.landedAt).toBeDefined();
  });

  it('未コミットの変更を捨てただけ（HEAD が origin に在るだけ）では landedAt を付けない', async () => {
    const memory = new RescueMemory();
    await writeFile(path.join(repo, 'a.txt'), 'edited, to be thrown away\n');
    const [first] = await run(memory);
    expect(first?.pushed).toBeDefined();
    g(repo, 'checkout', '--', 'a.txt');
    const second = await run(memory);
    // 変化の報告が出ても出なくても、landed は立たない。
    for (const report of second) expect(report.pushed?.landedAt).toBeUndefined();
  });

  it('退避 ref を消せる', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'edited\n');
    const [report] = await run();
    const pushed = report?.pushed as NonNullable<typeof report>['pushed'] & object;
    expect(refsInBare()).toContain(pushed.ref);
    const result = await del(pushed.ref, pushed.commit);
    expect(result).toEqual({ outcome: 'removed', alreadyGone: false });
    expect(refsInBare()).toBe('');
    // 一時の bare は残さない。
    expect(await readdir(tmp)).toEqual([]);
  });

  it('台帳より新しい退避が remote に在れば消さない（lease。moved）', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'edited\n');
    const memory = new RescueMemory();
    const [first] = await run(memory);
    await writeFile(path.join(repo, 'a.txt'), 'edited again\n');
    const [second] = await run(memory);
    expect(second?.pushed?.commit).not.toBe(first?.pushed?.commit);
    const result = await del(first?.pushed?.ref as string, first?.pushed?.commit as string);
    expect(result).toEqual({ outcome: 'failed', kind: 'moved' });
    expect(g(bare, 'rev-parse', first?.pushed?.ref as string).trim()).toBe(second?.pushed?.commit);
  });

  it('消そうとしたときに既に無ければ、消した（alreadyGone）として扱う', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'edited\n');
    const [report] = await run();
    const pushed = report?.pushed as NonNullable<typeof report>['pushed'] & object;
    g(bare, 'update-ref', '-d', pushed.ref);
    const result = await del(pushed.ref, pushed.commit);
    expect(result).toEqual({ outcome: 'removed', alreadyGone: true });
  });

  it('退避の名前空間の外の ref は、何を渡されても消さない', async () => {
    const main = g(bare, 'rev-parse', 'refs/heads/main').trim();
    for (const ref of [
      'refs/heads/main',
      'refs/alteroid-rescue/x',
      'refs/alteroid-rescue/a/b/c',
      'refs/alteroid-rescue/../heads/main',
      'refs/alteroid-rescue/a/b c',
    ]) {
      spawnCount = 0;
      expect(await del(ref, main)).toEqual({ outcome: 'failed', kind: 'other' });
      expect(spawnCount).toBe(0);
    }
    expect(g(bare, 'rev-parse', 'refs/heads/main').trim()).toBe(main);
  });

  it('commit の形が 40 桁の sha でなければ撃たない', async () => {
    spawnCount = 0;
    expect(await del('refs/alteroid-rescue/a/b', '--delete')).toEqual({
      outcome: 'failed',
      kind: 'other',
    });
    expect(spawnCount).toBe(0);
  });

  it('送り先が台帳の形（資格を落とした URL）でなければ撃たない', async () => {
    const commit = 'a'.repeat(40);
    for (const remote of [
      '--upload-pack=touch /tmp/x',
      'ext::sh -c touch% /tmp/x',
      'ext::foo',
      'https://user:secret@example.com/o/r.git',
      '',
    ]) {
      spawnCount = 0;
      expect(await del('refs/alteroid-rescue/a/b', commit, remote)).toEqual({
        outcome: 'failed',
        kind: 'no-remote',
      });
      expect(spawnCount).toBe(0);
    }
  });

  it('資格が無ければ、リモートのホストへは撃たない（auth）', async () => {
    spawnCount = 0;
    expect(
      await del('refs/alteroid-rescue/a/b', 'a'.repeat(40), 'https://example.invalid/o/r.git'),
    ).toEqual({ outcome: 'failed', kind: 'auth' });
    expect(spawnCount).toBe(0);
  });

  it('届かない remote は network として分類して返す（消したとは言わない）', async () => {
    const result = await deleteRescueRef({
      spawn: realSpawn,
      env: { ...GIT_ENV, GH_TOKEN: 'x' },
      remote: 'https://example.invalid/o/r.git',
      ref: 'refs/alteroid-rescue/a/b',
      commit: 'a'.repeat(40),
      tmpRootDir: tmp,
    });
    expect(result.outcome).toBe('failed');
    expect(await readdir(tmp)).toEqual([]);
  });

  it('remote の URL から資格を落とす', () => {
    expect(redactRemoteUrl('https://x-access-token:ghp_secret@github.com/o/r.git')).toBe(
      'https://github.com/o/r.git',
    );
    expect(redactRemoteUrl('https://github.com/o/r.git?token=abc#frag')).toBe(
      'https://github.com/o/r.git',
    );
    expect(redactRemoteUrl('ssh://git@example.com:2222/o/r.git')).toBe(
      'ssh://example.com:2222/o/r.git',
    );
    expect(redactRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(redactRemoteUrl('tok@en@github.com:o/r.git')).toBeUndefined();
    expect(redactRemoteUrl('someone@github.com:o/r.git')).toBe('github.com:o/r.git');
    expect(redactRemoteUrl('/srv/git/r.git')).toBe('/srv/git/r.git');
    expect(redactRemoteUrl('-oProxyCommand=x')).toBeUndefined();
    expect(redactRemoteUrl('has space')).toBeUndefined();
    expect(redactRemoteUrl('')).toBeUndefined();
  });

  it('退避 ref の名前は後始末が受ける形に収まる', () => {
    const ref = rescueRefName(managerId, repo, '.');
    expect(ref).toMatch(/^refs\/alteroid-rescue\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
  });
});
