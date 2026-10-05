import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyPushFailure,
  DEFAULT_RESCUE_INTERVAL_MS,
  filesWithSecretLikeAdditions,
  RESCUE_INTERVAL_MS_ENV_KEY,
  RESCUE_REF_PREFIX,
  RescueMemory,
  rescueRefName,
  resolveRescueIntervalMs,
  runRescue,
} from './rescue-ref.js';
import type { ProcessSpawnFn } from './unpushed-work.js';

// 実 git とローカルの bare リポジトリで見る（実リポジトリへは一切送らない）。
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

const realSpawn: ProcessSpawnFn = (o) =>
  spawn(o.command, o.args, {
    ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
    env: o.env as NodeJS.ProcessEnv,
    signal: o.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

describe('退避 ref（#1266）', () => {
  let root: string;
  let repo: string;
  let bare: string;
  const managerId = 'mgr-abcd1234-0000-0000-0000-000000000000';

  const run = (extra: Partial<Parameters<typeof runRescue>[1]> = {}, memory = new RescueMemory()) =>
    runRescue(repo, {
      managerId,
      spawn: realSpawn,
      env: { ...GIT_ENV, GH_TOKEN: 'x' },
      memory,
      tmpRootDir: path.join(root, 'no-tmp'),
      ...extra,
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'rescue-test-'));
    repo = path.join(root, 'repo');
    bare = path.join(root, 'origin.git');
    await mkdir(repo);
    g(root, 'init', '-q', '--bare', bare);
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'remote', 'add', 'origin', bare);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-qm', 'first');
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('追跡済みの未コミットの変更と未 push のコミットを送り、作業ツリーを動かさない', async () => {
    await writeFile(path.join(repo, 'b.txt'), 'unpushed commit\n');
    g(repo, 'add', 'b.txt');
    g(repo, 'commit', '-qm', 'second');
    await writeFile(path.join(repo, 'a.txt'), 'one\nedited\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'untracked body\n');
    const before = {
      head: g(repo, 'rev-parse', 'HEAD'),
      status: g(repo, 'status', '--porcelain'),
      reflog: g(repo, 'reflog'),
      cached: g(repo, 'diff', '--cached', '--stat'),
    };

    const reports = await run();

    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report?.pushed?.ref).toBe(rescueRefName(managerId, repo, '.'));
    expect(report?.pushed?.ref.startsWith(RESCUE_REF_PREFIX)).toBe(true);
    expect(report?.notPushed).toBeUndefined();
    // remote に在る。内容は追跡済みの変更を含み、未追跡は含まない。
    const ref = report?.pushed?.ref as string;
    expect(g(bare, 'rev-parse', ref).trim()).toBe(report?.pushed?.commit);
    expect(g(bare, 'show', `${ref}:a.txt`)).toBe('one\nedited\n');
    expect(g(bare, 'show', `${ref}:b.txt`)).toBe('unpushed commit\n');
    expect(g(bare, 'ls-tree', '-r', '--name-only', ref)).not.toContain('scratch.txt');
    // 退避されなかったもの（名前だけ）。
    expect(report?.untracked).toEqual({ count: 1, paths: ['scratch.txt'], omitted: 0 });
    // 作業ツリー・index・HEAD・reflog は動かない。refs/heads も増えない。
    expect(g(repo, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(g(repo, 'status', '--porcelain')).toBe(before.status);
    expect(g(repo, 'reflog')).toBe(before.reflog);
    expect(g(repo, 'diff', '--cached', '--stat')).toBe(before.cached);
    expect(existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
    expect(g(repo, 'stash', 'list')).toBe('');
    expect(g(repo, 'for-each-ref', 'refs/heads')).not.toContain('rescue');
    expect(await readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('one\nedited\n');
  });

  it('前回と同じ HEAD と tree なら送らず、変わったらまた送る', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'two\n');
    const memory = new RescueMemory();
    const first = await run({}, memory);
    expect(first).toHaveLength(1);
    expect(await run({}, memory)).toEqual([]);
    await writeFile(path.join(repo, 'a.txt'), 'three\n');
    const third = await run({}, memory);
    expect(third).toHaveLength(1);
    expect(third[0]?.pushed?.commit).not.toBe(first[0]?.pushed?.commit);
    // 同じ ref を force 更新している。
    expect(third[0]?.pushed?.ref).toBe(first[0]?.pushed?.ref);
    expect(g(bare, 'show', `${third[0]?.pushed?.ref as string}:a.txt`)).toBe('three\n');
  });

  it('追跡済みの変更も未 push も無ければ送らず、未追跡だけを台帳へ残す', async () => {
    await writeFile(path.join(repo, 'only-untracked.txt'), 'x');
    const [report] = await run();
    expect(report?.notPushed?.reason).toBe('nothing-tracked');
    expect(report?.pushed).toBeUndefined();
    expect(report?.untracked?.paths).toEqual(['only-untracked.txt']);
    expect(g(bare, 'for-each-ref', RESCUE_REF_PREFIX)).toBe('');
  });

  it('鍵らしい文字列が差分に在れば送らず、ファイル名だけを残す（文字列は残さない）', async () => {
    const fake = `gh${'p'}_${'A1b2'.repeat(9)}`;
    await writeFile(path.join(repo, 'a.txt'), `one\ntoken ${fake}\n`);
    const [report] = await run();
    expect(report?.notPushed).toEqual({ reason: 'secret-like', files: ['a.txt'] });
    expect(report?.pushed).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(fake);
    expect(g(bare, 'for-each-ref', RESCUE_REF_PREFIX)).toBe('');
  });

  it('未 push のコミットの中に在る鍵らしい文字列も止める', async () => {
    const fake = `gh${'p'}_${'Z9y8'.repeat(9)}`;
    await writeFile(path.join(repo, 'c.txt'), `${fake}\n`);
    g(repo, 'add', 'c.txt');
    g(repo, 'commit', '-qm', 'leak');
    await rm(path.join(repo, 'c.txt'));
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'remove');
    const [report] = await run();
    expect(report?.notPushed?.reason).toBe('secret-like');
    expect(report?.notPushed?.files).toEqual(['c.txt']);
  });

  it('環境変数の鍵の値が差分に在れば止める', async () => {
    const value = 'plain-looking-value-0123456789';
    await writeFile(path.join(repo, 'a.txt'), `one\n${value}\n`);
    const [report] = await run({ env: { ...GIT_ENV, GH_TOKEN: value } });
    expect(report?.notPushed?.reason).toBe('secret-like');
  });

  it('差分が上限を超えたら判定を打ち切って送らない側に倒す', async () => {
    await writeFile(path.join(repo, 'a.txt'), `one\n${'x'.repeat(5000)}\n`);
    const [report] = await run({ diffMaxBytes: 1000 });
    expect(report?.notPushed?.reason).toBe('too-large');
    expect(g(bare, 'for-each-ref', RESCUE_REF_PREFIX)).toBe('');
  });

  it('資格が無ければ送らず、未追跡は台帳に残す', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'changed\n');
    await writeFile(path.join(repo, 'u.txt'), 'u');
    const [report] = await run({ env: { ...GIT_ENV } });
    expect(report?.notPushed?.reason).toBe('no-credential');
    expect(report?.untracked?.count).toBe(1);
    expect(g(bare, 'for-each-ref', RESCUE_REF_PREFIX)).toBe('');
  });

  it('origin が無ければ送らない', async () => {
    g(repo, 'remote', 'remove', 'origin');
    await writeFile(path.join(repo, 'a.txt'), 'changed\n');
    const [report] = await run();
    expect(report?.notPushed?.reason).toBe('no-remote');
  });

  it('push が失敗したら理由を分類して残し、次の周期で再び試す', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'changed\n');
    g(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    const memory = new RescueMemory();
    const [report] = await run({}, memory);
    expect(report?.notPushed?.reason).toBe('push-failed');
    expect(report?.notPushed?.failureKind).toBeDefined();
    // 直す。同じ HEAD・tree でも、失敗は確定させていないので再び送る。
    g(repo, 'remote', 'set-url', 'origin', bare);
    const [again] = await run({}, memory);
    expect(again?.pushed?.ref).toBeDefined();
  });

  it('未追跡のパスは上限つきで、溢れたら件数だけ', async () => {
    for (let i = 0; i < 25; i += 1) await writeFile(path.join(repo, `u${String(i)}.txt`), 'x');
    const [report] = await run();
    expect(report?.untracked?.count).toBe(25);
    expect(report?.untracked?.paths).toHaveLength(20);
    expect(report?.untracked?.omitted).toBe(5);
  });

  it('HEAD が無い（unborn）作業ツリーでも、git add 済みのファイルを送る', async () => {
    const fresh = path.join(root, 'fresh');
    await mkdir(fresh);
    g(fresh, 'init', '-q', '-b', 'main');
    g(fresh, 'remote', 'add', 'origin', bare);
    await writeFile(path.join(fresh, 'new.txt'), 'staged\n');
    g(fresh, 'add', 'new.txt');
    const [report] = await runRescue(fresh, {
      managerId,
      spawn: realSpawn,
      env: { ...GIT_ENV, GH_TOKEN: 'x' },
      memory: new RescueMemory(),
      tmpRootDir: path.join(root, 'no-tmp'),
    });
    expect(report?.pushed?.ref).toBeDefined();
    expect(g(bare, 'show', `${report?.pushed?.ref as string}:new.txt`)).toBe('staged\n');
    expect(g(fresh, 'status', '--porcelain')).toBe('A  new.txt\n');
  });

  it('git worktree で足した作業ツリーも、別の名前で一意に退避する', async () => {
    const wt = path.join(repo, 'wt');
    g(repo, 'worktree', 'add', '-q', '-b', 'topic', wt);
    await writeFile(path.join(wt, 'a.txt'), 'in worktree\n');
    const reports = await run();
    // 本体（変更なし）は送るものが無く、worktree だけが送られる。
    expect(reports.map((r) => r.relativePath).sort()).toEqual(['.', 'wt']);
    const refs = reports.filter((r) => r.pushed !== undefined).map((r) => r.pushed?.ref);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/^refs\/alteroid-rescue\/mgr-abcd1234-[0-9a-f-]+\/wt-[0-9a-f]{8}$/);
    expect(g(bare, 'show', `${refs[0] as string}:a.txt`)).toBe('in worktree\n');
  });

  it('退避 ref の名前は git の ref として正しい', () => {
    for (const rel of ['.', 'a b/c', '日本語/x', '../../etc', '/tmp/x.lock']) {
      const name = rescueRefName(managerId, '/tmp/x', rel);
      expect(() => g(root, 'check-ref-format', name)).not.toThrow();
    }
    expect(rescueRefName(managerId, '/a', '.')).not.toBe(rescueRefName(managerId, '/b', '.'));
  });

  it('伏せ字の判定は追加行だけを見て、ファイル名を返す', () => {
    const fake = `gh${'p'}_${'Q7w3'.repeat(9)}`;
    const diff = [
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      `-${fake}`,
      '+ok',
      'diff --git a/y.txt b/y.txt',
      `+${fake}`,
    ].join('\n');
    expect(filesWithSecretLikeAdditions(diff, undefined)).toEqual(['y.txt']);
  });

  it('push の失敗を分類する', () => {
    expect(classifyPushFailure({ stderr: '', timedOut: true })).toBe('timeout');
    expect(
      classifyPushFailure({ stderr: 'fatal: Authentication failed for', timedOut: false }),
    ).toBe('auth');
    expect(classifyPushFailure({ stderr: '! [remote rejected] protected', timedOut: false })).toBe(
      'rejected',
    );
    expect(classifyPushFailure({ stderr: 'Could not resolve host', timedOut: false })).toBe(
      'network',
    );
    expect(classifyPushFailure({ stderr: 'boom', timedOut: false })).toBe('other');
  });

  it('周期は環境変数で変えられ、読めない値は既定へ倒す', () => {
    expect(resolveRescueIntervalMs({})).toBe(DEFAULT_RESCUE_INTERVAL_MS);
    expect(resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: '1000' })).toBe(1000);
    expect(resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: 'abc' })).toBe(
      DEFAULT_RESCUE_INTERVAL_MS,
    );
    expect(resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: '0' })).toBe(
      DEFAULT_RESCUE_INTERVAL_MS,
    );
  });
});
