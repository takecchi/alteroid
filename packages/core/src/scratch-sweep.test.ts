import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SCRATCH_SWEEP_GRACE_MS,
  DEFAULT_SCRATCH_SWEEP_INTERVAL_MS,
  ScratchSweeper,
  resolveScratchSweepGraceMs,
  resolveScratchSweepIntervalMs,
  type ScratchSweeperOptions,
} from './scratch-sweep.js';
import { rm } from 'node:fs/promises';
import type { ProcessSpawnFn } from './unpushed-work.js';

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

const ID_A = 'mgr-aaaa1111-0000-0000-0000-000000000000';
const GRACE = 1000;

describe('/tmp の委譲の作業場の片付け（#3039）', () => {
  let root: string; // これが「/tmp」
  let origins: string;
  let t: number;
  let live: string[];
  let known: string[];
  let rmCalls: string[];
  let spawnFn: ProcessSpawnFn;

  const sweeper = (extra: Partial<ScratchSweeperOptions> = {}): ScratchSweeper =>
    new ScratchSweeper({
      tmpRoot: root,
      spawn: (o) => spawnFn(o),
      env: GIT_ENV,
      liveManagerIds: () => live,
      knownManagerIds: () => known,
      graceMs: GRACE,
      startedAt: 0,
      now: () => t,
      rmFn: async (p) => {
        rmCalls.push(p);
        await rm(p, { recursive: true, force: true });
      },
      ...extra,
    });
  const ctl = new AbortController();

  /** 起点の clone（push 済み）を `<root>/<dir>/repo` に作る。 */
  async function makeClone(dir: string, repoName = 'repo'): Promise<string> {
    const repo = path.join(root, dir, repoName);
    const bare = path.join(origins, `${dir}-${repoName}.git`);
    await mkdir(repo, { recursive: true });
    g(origins, 'init', '-q', '--bare', bare);
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'remote', 'add', 'origin', bare);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-qm', 'first');
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
    return repo;
  }

  /** 最初の走査（起動時に在ったものとして数え始める）→ 猶予を過ぎるまで進める。 */
  async function expire(s: ScratchSweeper): Promise<void> {
    t = 0;
    await s.sweep(ctl.signal, 'r1');
    t = GRACE;
  }

  beforeEach(async () => {
    root = await makeTempDir('scratch-sweep-root-');
    origins = await makeTempDir('scratch-sweep-origins-');
    t = 0;
    live = [];
    known = [];
    rmCalls = [];
    spawnFn = realSpawn;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(origins, { recursive: true, force: true });
  });

  it('猶予未満は消さず、猶予を過ぎて clean なら消す（何も無い回は送らない）', async () => {
    await makeClone('mgr-aaaa1111');
    const s = sweeper();
    t = 0;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    t = GRACE - 1;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    expect(existsSync(path.join(root, 'mgr-aaaa1111'))).toBe(true);
    t = GRACE;
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(root, 'mgr-aaaa1111'))).toBe(false);
    expect(event?.removed.map((i) => i.name)).toEqual(['mgr-aaaa1111']);
    expect(event?.kept).toEqual([]);
    expect(event?.statfs).toBeDefined();
    // 消した後は何も無い回: 送らない。
    t = GRACE * 5;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
  });

  it('走行中のセッションに当たる作業場は、猶予を過ぎても消さない。閉じた後は閉じてから数える', async () => {
    await makeClone('mgr-aaaa1111-wt2');
    live = [ID_A];
    const s = sweeper();
    t = 0;
    await s.sweep(ctl.signal, 'r1');
    t = GRACE * 100;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    expect(existsSync(path.join(root, 'mgr-aaaa1111-wt2'))).toBe(true);
    // 閉じた（誰にも当たらなくなった）。この時刻から数える。
    live = [];
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    t += GRACE - 1;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    expect(existsSync(path.join(root, 'mgr-aaaa1111-wt2'))).toBe(true);
    t += 1;
    expect((await s.sweep(ctl.signal, 'r1'))?.removed).toHaveLength(1);
  });

  it('調べている間に再開した委譲の作業場は、消す直前の突き合わせで守る', async () => {
    await makeClone('mgr-aaaa1111');
    const s = sweeper();
    await expire(s);
    // git を最初に起こした瞬間に、委譲が再開された（`#sessions` に戻った）ことにする。
    spawnFn = (o) => {
      live = [ID_A];
      return realSpawn(o);
    };
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(root, 'mgr-aaaa1111', 'repo', 'a.txt'))).toBe(true);
    expect(rmCalls).toEqual([]);
    expect(event).toBeNull();
  });

  it('未 push のコミットがあれば残す（ファイルが在る）', async () => {
    const repo = await makeClone('mgr-aaaa1111');
    await writeFile(path.join(repo, 'b.txt'), 'two\n');
    g(repo, 'add', 'b.txt');
    g(repo, 'commit', '-qm', 'unpushed');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'b.txt'))).toBe(true);
    expect(event?.removed).toEqual([]);
    expect(event?.kept).toMatchObject([
      { name: 'mgr-aaaa1111', reason: 'unpushed-commits', count: 1 },
    ]);
  });

  it('HEAD は push 済みで、別のローカル枝にだけ未 push のコミットがあれば残す', async () => {
    const repo = await makeClone('mgr-aaaa1111');
    g(repo, 'checkout', '-q', '-b', 'other');
    await writeFile(path.join(repo, 'o.txt'), 'other\n');
    g(repo, 'add', 'o.txt');
    g(repo, 'commit', '-qm', 'only on other');
    g(repo, 'checkout', '-q', 'main');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
    expect(event?.kept).toMatchObject([{ reason: 'unpushed-commits', count: 1 }]);
  });

  it('detached HEAD の未 push のコミットは残す（枝に載っていない）', async () => {
    const repo = await makeClone('mgr-aaaa1111');
    g(repo, 'checkout', '-q', '--detach');
    await writeFile(path.join(repo, 'd.txt'), 'detached\n');
    g(repo, 'add', 'd.txt');
    g(repo, 'commit', '-qm', 'detached');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'd.txt'))).toBe(true);
    expect(event?.kept).toMatchObject([{ reason: 'unpushed-commits' }]);
  });

  it('git stash の変更だけがある作業場は残す', async () => {
    const repo = await makeClone('mgr-aaaa1111');
    await writeFile(path.join(repo, 'a.txt'), 'stashed\n');
    g(repo, 'stash', 'push', '-q');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
    expect(event?.removed).toEqual([]);
    expect(event?.kept).toMatchObject([{ name: 'mgr-aaaa1111', reason: 'stash' }]);
  });

  it('追跡済みの未コミットの変更があれば残す', async () => {
    const repo = await makeClone('mgr-aaaa1111');
    await writeFile(path.join(repo, 'a.txt'), 'changed\n');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
    expect(event?.kept).toMatchObject([{ name: 'mgr-aaaa1111', reason: 'tracked-changes' }]);
  });

  // 経緯: 当初は「未追跡だけなら消し、名前を記録する」だった。依頼者のレビューで、
  // `.gitignore` 除外後に残る未追跡は書きかけの成果である見込みが高いので、1つでもあれば残す、へ反転した。
  it('未追跡のファイルが1つでもあれば残し、件数と名前を載せる（.gitignore は数えない）', async () => {
    const repo = await makeClone('mgr-aaaa1111');
    await writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    g(repo, 'add', '.gitignore');
    g(repo, 'commit', '-qm', 'ignore');
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
    await writeFile(path.join(repo, 'scratch.txt'), 'x');
    await writeFile(path.join(repo, 'ignored.txt'), 'x');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'scratch.txt'))).toBe(true);
    expect(event?.removed).toEqual([]);
    expect(event?.kept).toMatchObject([
      {
        name: 'mgr-aaaa1111',
        reason: 'untracked-files',
        count: 1,
        untracked: { count: 1, names: ['repo/scratch.txt'] },
      },
    ]);
  });

  it('この runner が一度でも起こした委譲（畳まれて live から消えたもの）は、猶予を過ぎても消さない', async () => {
    await makeClone('mgr-aaaa1111');
    known = [ID_A];
    live = [];
    const s = sweeper();
    t = 0;
    await s.sweep(ctl.signal, 'r1');
    t = GRACE * 1000;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    expect(existsSync(path.join(root, 'mgr-aaaa1111', 'repo', 'a.txt'))).toBe(true);
    expect(rmCalls).toEqual([]);
    // 知らない名前（孤児）は今までどおり猶予で消える。
    await makeClone('mgr-bbbb2222');
    t += 1;
    await s.sweep(ctl.signal, 'r1');
    t += GRACE;
    expect((await s.sweep(ctl.signal, 'r1'))?.removed.map((i) => i.name)).toEqual(['mgr-bbbb2222']);
  });

  it('git が失敗する（判定できない）なら残す', async () => {
    await makeClone('mgr-aaaa1111');
    const s = sweeper();
    await expire(s);
    spawnFn = (o) => realSpawn({ ...o, command: 'false', args: [] });
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(root, 'mgr-aaaa1111', 'repo', 'a.txt'))).toBe(true);
    expect(event?.kept).toMatchObject([{ name: 'mgr-aaaa1111', reason: 'undecidable' }]);
    expect(event?.removed).toEqual([]);
  });

  it('git が期限切れでも残す', async () => {
    await makeClone('mgr-aaaa1111');
    const s = sweeper({ gitTimeoutMs: 50 });
    await expire(s);
    spawnFn = (o) => realSpawn({ ...o, command: 'sleep', args: ['5'] });
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(root, 'mgr-aaaa1111', 'repo', 'a.txt'))).toBe(true);
    expect(event?.kept).toMatchObject([{ reason: 'undecidable' }]);
  });

  it('読めない子ディレクトリがあれば残す（探索の打ち切りも）', async () => {
    await makeClone('mgr-aaaa1111');
    const s = sweeper({
      gitReaddirFn: async (dir) => {
        if (dir.endsWith('mgr-aaaa1111')) {
          return [
            { name: 'repo', isDirectory: () => true },
            { name: 'locked', isDirectory: () => true },
          ];
        }
        throw new Error('EACCES');
      },
    });
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(root, 'mgr-aaaa1111'))).toBe(true);
    expect(event?.kept).toMatchObject([{ reason: 'undecidable' }]);
  });

  it('深さ5に .git（未 push のコミット付き）がある作業場は消えない。深さ上限を超える枝は判定できないとして残す', async () => {
    const deep = path.join(root, 'mgr-aaaa1111', 'a', 'b', 'c', 'd');
    await mkdir(path.dirname(deep), { recursive: true });
    await mkdir(deep, { recursive: true });
    const repo = path.join(deep, 'repo');
    await mkdir(repo);
    const bare = path.join(origins, 'deep.git');
    g(origins, 'init', '-q', '--bare', bare);
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'remote', 'add', 'origin', bare);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-qm', 'unpushed');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
    expect(event?.kept).toMatchObject([{ name: 'mgr-aaaa1111', reason: 'unpushed-commits' }]);

    // 深さ上限そのものを小さくすると、降りなかった枝として「判定できない」で残す。
    const s2 = sweeper({ maxDepth: 2 });
    await expire(s2);
    const event2 = await s2.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(repo, 'a.txt'))).toBe(true);
    expect(event2?.kept).toMatchObject([{ reason: 'undecidable' }]);
  });

  it('主リポジトリが clean でも、残す linked worktree が依存していれば主を残す', async () => {
    const main = await makeClone('mgr-aaaa1111');
    const wt = path.join(root, 'mgr-bbbb2222', 'wt');
    await mkdir(path.dirname(wt), { recursive: true });
    g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    // 注: linked の枝にコミットすると、主からも `--branches` で未 push と数えられる。
    // 依存の歯は「主は clean・linked は未コミットの変更」で見る。
    await writeFile(path.join(wt, 'a.txt'), 'dirty in worktree\n');
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(wt, 'a.txt'))).toBe(true);
    expect(existsSync(path.join(main, 'a.txt'))).toBe(true);
    expect(event?.kept.map((i) => `${i.name}:${i.reason ?? ''}`).sort()).toEqual([
      'mgr-aaaa1111:worktree-dependency',
      'mgr-bbbb2222:tracked-changes',
    ]);
    expect(event?.removed).toEqual([]);
  });

  it('linked worktree 側だけが clean なら、その側だけ消す（主は残る）', async () => {
    const main = await makeClone('mgr-aaaa1111');
    await writeFile(path.join(main, 'a.txt'), 'dirty\n');
    const wt = path.join(root, 'mgr-bbbb2222', 'wt');
    await mkdir(path.dirname(wt), { recursive: true });
    g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(existsSync(path.join(root, 'mgr-bbbb2222'))).toBe(false);
    expect(existsSync(path.join(main, 'a.txt'))).toBe(true);
    expect(event?.removed.map((i) => i.name)).toEqual(['mgr-bbbb2222']);
  });

  it('主と linked の両方が clean なら両方消える（不動点）', async () => {
    const main = await makeClone('mgr-aaaa1111');
    const wt = path.join(root, 'mgr-bbbb2222', 'wt');
    await mkdir(path.dirname(wt), { recursive: true });
    g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(event?.removed.map((i) => i.name).sort()).toEqual(['mgr-aaaa1111', 'mgr-bbbb2222']);
  });

  it('当たらない名前（.pnpm-store・21文字・mgr-c65）には降りず、触らない', async () => {
    for (const name of ['.pnpm-store', 'abcdefghijklmnopqrstu', 'mgr-c65', 'tsx-1001']) {
      await mkdir(path.join(root, name, 'x'), { recursive: true });
      await writeFile(path.join(root, name, 'x', 'f'), 'keep');
    }
    const readdirs: string[] = [];
    const s = sweeper({
      gitReaddirFn: async (dir) => {
        readdirs.push(dir);
        return [];
      },
    });
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(event).toBeNull();
    for (const name of ['.pnpm-store', 'abcdefghijklmnopqrstu', 'mgr-c65', 'tsx-1001']) {
      expect(existsSync(path.join(root, name, 'x', 'f'))).toBe(true);
    }
    expect(readdirs).toEqual([]);
    expect(rmCalls).toEqual([]);
  });

  it('ファイルと .git の無いディレクトリは猶予後に消す。シンボリックリンクは追わず、リンクだけ消す', async () => {
    await writeFile(path.join(root, 'mgr-aaaa1111-p10-verify.log'), '');
    await mkdir(path.join(root, 'mgr-bbbb2222-logs'));
    const outside = await makeTempDir('scratch-sweep-outside-');
    await writeFile(path.join(outside, 'precious'), 'p');
    await symlink(outside, path.join(root, 'mgr-cccc3333'));
    const s = sweeper();
    await expire(s);
    const event = await s.sweep(ctl.signal, 'r1');
    expect(event?.removed.map((i) => `${i.name}:${i.kind}`).sort()).toEqual([
      'mgr-aaaa1111-p10-verify.log:file',
      'mgr-bbbb2222-logs:directory',
      'mgr-cccc3333:symlink',
    ]);
    expect(existsSync(path.join(root, 'mgr-cccc3333'))).toBe(false);
    expect(existsSync(path.join(outside, 'precious'))).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  it('同じ「残した」は繰り返し送らない。消えて再び残せば再び送る', async () => {
    const repo = await makeClone('mgr-aaaa1111');
    await writeFile(path.join(repo, 'a.txt'), 'dirty\n');
    const s = sweeper();
    await expire(s);
    expect((await s.sweep(ctl.signal, 'r1'))?.kept).toHaveLength(1);
    t += 10;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    t += 10;
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
    // 直された（clean）→ 消える。
    g(repo, 'checkout', '--', 'a.txt');
    expect((await s.sweep(ctl.signal, 'r1'))?.removed).toHaveLength(1);
  });

  it('/tmp を読めない回は理由を運び、同じ理由は繰り返さない', async () => {
    const s = sweeper({
      readdirFn: async () => {
        throw new Error('EMFILE');
      },
    });
    expect((await s.sweep(ctl.signal, 'r1'))?.scanError).toContain('EMFILE');
    expect(await s.sweep(ctl.signal, 'r1')).toBeNull();
  });

  it('rm が失敗したら残した（rm-failed）として運ぶ', async () => {
    await writeFile(path.join(root, 'mgr-aaaa1111.log'), '');
    const s = sweeper({
      rmFn: async () => {
        throw new Error('EBUSY');
      },
    });
    await expire(s);
    expect((await s.sweep(ctl.signal, 'r1'))?.kept).toMatchObject([{ reason: 'rm-failed' }]);
  });

  it('中断された回は何も消さない', async () => {
    await writeFile(path.join(root, 'mgr-aaaa1111.log'), '');
    const s = sweeper();
    await expire(s);
    const aborted = new AbortController();
    aborted.abort();
    await s.sweep(aborted.signal, 'r1');
    expect(existsSync(path.join(root, 'mgr-aaaa1111.log'))).toBe(true);
  });

  it('statfs の観測と、取れなかった理由', async () => {
    await writeFile(path.join(root, 'mgr-aaaa1111.log'), '');
    const ok = sweeper({
      statfsFn: async () => ({ bsize: 4096, blocks: 100, bfree: 40, files: 1000, ffree: 250 }),
    });
    await expire(ok);
    expect((await ok.sweep(ctl.signal, 'r1'))?.statfs).toEqual({
      totalBytes: 409600,
      usedBytes: 245760,
      totalInodes: 1000,
      usedInodes: 750,
    });
    await writeFile(path.join(root, 'mgr-bbbb2222.log'), '');
    const ng = sweeper({
      statfsFn: async () => {
        throw new Error('ENOSYS');
      },
    });
    await expire(ng);
    expect((await ng.sweep(ctl.signal, 'r1'))?.statfs).toEqual({
      unavailable: expect.stringContaining('ENOSYS'),
    });
  });
});

describe('消す直前の安全検査（基点・対象の形）', () => {
  const file = (name: string) => ({
    name,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  });
  async function run(tmpRoot: string, names: string[]) {
    const calls: string[] = [];
    const s = new ScratchSweeper({
      tmpRoot,
      spawn: realSpawn,
      env: GIT_ENV,
      liveManagerIds: () => [],
      graceMs: 0,
      startedAt: 0,
      now: () => 0,
      readdirFn: async () => names.map(file),
      sizeFn: async () => 0,
      rmFn: async (p) => {
        calls.push(p);
      },
    });
    const event = await s.sweep(new AbortController().signal, 'r1');
    return { calls, event };
  }

  it.each(['', '/', 'relative/tmp', '.', '/tmp/..'])(
    '基点が %j なら rm を呼ばず残す',
    async (base) => {
      const { calls, event } = await run(base, ['mgr-aaaa1111.log']);
      expect(calls).toEqual([]);
      expect(event?.kept).toMatchObject([{ reason: 'unsafe-target' }]);
    },
  );

  it.each([
    ['mgr-aaaa1111/..'], // 基点そのもの
    ['mgr-aaaa1111/../..'], // 基点の外
    ['mgr-aaaa1111/sub'], // 2階層下
    ['mgr-aaaa1111/../../etc'],
  ])('対象 %j が基点の直下でなければ rm を呼ばず残す', async (name) => {
    const { calls, event } = await run('/tmp/scratch-guard-base', [name]);
    expect(calls).toEqual([]);
    expect(event?.kept).toMatchObject([{ reason: 'unsafe-target' }]);
  });

  it('正しい形（基点の直下・mgr- 規則）なら rm を呼ぶ', async () => {
    const { calls } = await run('/tmp/scratch-guard-base', ['mgr-aaaa1111.log']);
    expect(calls).toEqual(['/tmp/scratch-guard-base/mgr-aaaa1111.log']);
  });
});

describe('片付けの猶予・周期の env', () => {
  it('既定と、範囲外は既定へ倒す', () => {
    expect(resolveScratchSweepGraceMs({})).toBe(DEFAULT_SCRATCH_SWEEP_GRACE_MS);
    expect(resolveScratchSweepIntervalMs({})).toBe(DEFAULT_SCRATCH_SWEEP_INTERVAL_MS);
    expect(resolveScratchSweepGraceMs({ ALTEROID_SCRATCH_SWEEP_GRACE_MS: '5000' })).toBe(5000);
    expect(resolveScratchSweepGraceMs({ ALTEROID_SCRATCH_SWEEP_GRACE_MS: '-1' })).toBe(
      DEFAULT_SCRATCH_SWEEP_GRACE_MS,
    );
    expect(resolveScratchSweepGraceMs({ ALTEROID_SCRATCH_SWEEP_GRACE_MS: 'abc' })).toBe(
      DEFAULT_SCRATCH_SWEEP_GRACE_MS,
    );
    expect(resolveScratchSweepIntervalMs({ ALTEROID_SCRATCH_SWEEP_INTERVAL_MS: '30000' })).toBe(
      30000,
    );
    expect(resolveScratchSweepIntervalMs({ ALTEROID_SCRATCH_SWEEP_INTERVAL_MS: '0' })).toBe(
      DEFAULT_SCRATCH_SWEEP_INTERVAL_MS,
    );
    expect(
      resolveScratchSweepIntervalMs({ ALTEROID_SCRATCH_SWEEP_INTERVAL_MS: '99999999999' }),
    ).toBe(DEFAULT_SCRATCH_SWEEP_INTERVAL_MS);
  });
});
