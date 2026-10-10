import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.test-support.js';
import { unpushedWorkResultSchema, unpushedWorkTreeSchema } from './runner-protocol.js';
import {
  computeUnpushedWork,
  DEFAULT_MAX_DEPTH,
  findGitDirs,
  findManagerScratchRoots,
  matchesManagerScratchDirName,
  parseRemoteOriginUrl,
  type ProcessSpawnFn,
  type ReaddirFn,
} from './unpushed-work.js';

let root: string;

beforeEach(() => {
  root = makeTempDirSync('alteroid-unpushed-work-');
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...gitChildEnv(), GIT_TERMINAL_PROMPT: '0' },
  });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

function commitFile(dir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(dir, filename), content);
  git(dir, ['add', filename]);
  git(dir, ['commit', '-q', '-m', message]);
}

const realSpawn: ProcessSpawnFn = (options) =>
  spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    signal: options.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('findGitDirs', () => {
  it('job.cwd 自体が .git を持つ場合も拾う', async () => {
    initRepo(root);
    const found = await findGitDirs(root);
    expect(found.paths).toEqual([root]);
    expect(found.truncatedAtCount).toBeUndefined();
  });

  it('見つかった .git を全部返す（1本目だけを返さない）', async () => {
    initRepo(join(root, 'mgr-x', 'repo'));
    initRepo(join(root, 'mgr-x', 'wt-a'));
    initRepo(join(root, 'mgr-x', 'wt-b'));

    const found = await findGitDirs(root);

    expect(found.paths.map((p) => p.slice(root.length + 1)).sort()).toEqual([
      'mgr-x/repo',
      'mgr-x/wt-a',
      'mgr-x/wt-b',
    ]);
  });

  it('深さ上限3までは見つけ、その先は見つけない（既定）', async () => {
    initRepo(join(root, 'a', 'b', 'c'));
    initRepo(join(root, 'a', 'b', 'c', 'd'));

    const found = await findGitDirs(root, { maxDepth: DEFAULT_MAX_DEPTH });

    const relative = found.paths.map((p) => p.slice(root.length + 1)).sort();
    expect(relative).toContain('a/b/c');
    expect(relative).not.toContain('a/b/c/d');
  });

  it('maxDepth を広げれば4階層下も見つかる（境界の確認）', async () => {
    initRepo(join(root, 'a', 'b', 'c', 'd'));
    const found = await findGitDirs(root, { maxDepth: 4 });
    expect(found.paths.map((p) => p.slice(root.length + 1))).toEqual(['a/b/c/d']);
  });

  it('node_modules の下は探索しない', async () => {
    initRepo(join(root, 'node_modules', 'some-package'));
    initRepo(join(root, 'repo'));

    const found = await findGitDirs(root);

    const relative = found.paths.map((p) => p.slice(root.length + 1));
    expect(relative).toEqual(['repo']);
  });

  it('件数の上限に当たったら打ち切ったと名乗る（黙って切らない）', async () => {
    initRepo(join(root, 'r1'));
    initRepo(join(root, 'r2'));
    initRepo(join(root, 'r3'));

    const found = await findGitDirs(root, { maxCount: 2 });

    expect(found.paths).toHaveLength(2);
    expect(found.truncatedAtCount).toBe(2);
  });

  it('⭐ 子ディレクトリの readdir が失敗したら unreadableDirCount に数え、見つかった分はそのまま返す（Issue #1865）', async () => {
    initRepo(join(root, 'visible'));
    const brokenChild = join(root, 'broken-child');
    mkdirSync(brokenChild, { recursive: true });

    const readdirFn: ReaddirFn = async (dir) => {
      if (dir === brokenChild) {
        throw Object.assign(new Error('EACCES: permission denied, scandir (テスト用の模擬失敗)'), {
          code: 'EACCES',
        });
      }
      return readdir(dir, { withFileTypes: true });
    };

    const found = await findGitDirs(root, { readdirFn });

    expect(found.paths).toEqual([join(root, 'visible')]);
    expect(found.unreadableDirCount).toBe(1);
    expect(found.unreadableDirSample).toContain(brokenChild);
    expect(found.unreadableDirSample).toContain('EACCES');
  });

  it('複数の子ディレクトリが読めなくても件数として数える（サンプルは最初の1件だけ）', async () => {
    initRepo(join(root, 'visible'));
    const brokenA = join(root, 'broken-a');
    const brokenB = join(root, 'broken-b');
    mkdirSync(brokenA, { recursive: true });
    mkdirSync(brokenB, { recursive: true });

    const readdirFn: ReaddirFn = async (dir) => {
      if (dir === brokenA || dir === brokenB) {
        throw new Error(`模擬失敗: ${dir}`);
      }
      return readdir(dir, { withFileTypes: true });
    };

    const found = await findGitDirs(root, { readdirFn });

    expect(found.paths).toEqual([join(root, 'visible')]);
    expect(found.unreadableDirCount).toBe(2);
    expect(found.unreadableDirSample).toBeDefined();
  });

  it('対照: 子ディレクトリがすべて読めるときは unreadableDirCount / unreadableDirSample が省略される', async () => {
    initRepo(join(root, 'visible'));
    mkdirSync(join(root, 'plain-child'), { recursive: true });

    const found = await findGitDirs(root);

    expect(found.paths).toEqual([join(root, 'visible')]);
    expect(found.unreadableDirCount).toBeUndefined();
    expect(found.unreadableDirSample).toBeUndefined();
  });

  it('起点自身の readdir 失敗（rootUnreadable）は unreadableDirCount に数えない（別軸のまま）', async () => {
    const readdirFn: ReaddirFn = async (dir) => {
      if (dir === root) {
        throw new Error('模擬: 起点そのものが読めない');
      }
      return readdir(dir, { withFileTypes: true });
    };

    const found = await findGitDirs(root, { readdirFn });

    expect(found.rootUnreadable).toBeDefined();
    expect(found.unreadableDirCount).toBeUndefined();
    expect(found.paths).toEqual([]);
  });
});

describe('computeUnpushedWork — 未 push の定義（@{u} ではなく --not --remotes=origin）', () => {
  it('upstream 未設定の枝でも未 push のコミット数を検出できる（@{u} は落ちる）', async () => {
    const bare = join(root, 'origin.git');
    mkdirSync(bare, { recursive: true });
    git(bare, ['init', '-q', '--bare']);

    const work = join(root, 'work');
    initRepo(work);
    commitFile(work, 'a.txt', 'first\n', 'first commit');
    git(work, ['remote', 'add', 'origin', bare]);
    git(work, ['push', '-q', 'origin', 'HEAD:main']);
    git(work, ['fetch', '-q', 'origin']);

    commitFile(work, 'b.txt', 'second\n', 'second commit');
    commitFile(work, 'c.txt', 'third\n', 'third commit');

    expect(() => git(work, ['rev-list', '--count', '@{u}..HEAD'])).toThrow();

    const result = await computeUnpushedWork(work, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]?.unpushedCommitCount).toBe(2);
    expect(result.worktrees[0]?.unpushedCommitCountUnknown).toBeUndefined();
    expect(result.worktrees[0]?.branch).toBe('main');
  });

  it('リモートを一切持たない枝でも「確かめられなかった」にならない', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');
    commitFile(root, 'b.txt', 'second\n', 'second');

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees[0]?.unpushedCommitCount).toBe(2);
  });
});

describe('computeUnpushedWork — 未コミットの変更（git status --porcelain の行数）', () => {
  it('未コミットの変更の件数を数える', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees[0]?.uncommittedChangeCount).toBe(2);
  });

  it('未コミットの変更が無ければ0件と正しく言う（0と確かめられなかったを混ぜない）', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees[0]?.uncommittedChangeCount).toBe(0);
    expect(result.worktrees[0]?.uncommittedChangeCountUnknown).toBeUndefined();
  });
});

describe('computeUnpushedWork — 倒れ先（HEAD が無効・detached HEAD）', () => {
  it('コミットが1本も無い枝（HEAD が無効）は「確かめられなかった」と名乗り、0とは混ぜない', async () => {
    initRepo(root);

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    const tree = result.worktrees[0];
    expect(tree).toBeDefined();
    expect(tree?.unpushedCommitCount).toBeUndefined();
    expect(tree?.unpushedCommitCountUnknown).toBeDefined();
    expect(tree?.unpushedCommitCountUnknown).not.toBe('0');
  });

  it('detached HEAD では枝名を null にするが、未 push の件数は普通に数える', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');
    const sha = git(root, ['rev-parse', 'HEAD']).trim();
    commitFile(root, 'b.txt', 'second\n', 'second');
    git(root, ['checkout', '-q', sha]);

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees[0]?.branch).toBeNull();
    expect(result.worktrees[0]?.unpushedCommitCount).toBe(1);
  });
});

describe('computeUnpushedWork — 出す粒度（ファイル名・差分の中身・コミットメッセージ・author を出さない）', () => {
  it('ファイル名・コミットメッセージ・authorが応答に1文字も出ない', async () => {
    initRepo(root);
    writeFileSync(join(root, 'super-secret-filename.txt'), 'TOP SECRET DIFF CONTENT\n');
    git(root, ['add', 'super-secret-filename.txt']);
    git(root, [
      '-c',
      'user.name=Secret Author',
      '-c',
      'user.email=secret@example.com',
      'commit',
      '-q',
      '-m',
      'SUPER SECRET COMMIT MESSAGE',
    ]);
    writeFileSync(join(root, 'super-secret-filename.txt'), 'TOP SECRET DIFF CONTENT v2\n');

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });
    const serialized = JSON.stringify(result);

    expect(result.worktrees[0]?.uncommittedChangeCount).toBe(1);
    for (const forbidden of [
      'super-secret-filename.txt',
      'TOP SECRET DIFF CONTENT',
      'SUPER SECRET COMMIT MESSAGE',
      'Secret Author',
      'secret@example.com',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('unpushedWorkTreeSchema が持つ欄は、有無・件数・枝名・origin の host/path までに限られる（形そのものの固定。Issue #1376 B2 で remoteOrigin を1つだけ広げた）', () => {
    expect(Object.keys(unpushedWorkTreeSchema.shape).sort()).toEqual(
      [
        'relativePath',
        'branch',
        'unpushedCommitCount',
        'unpushedCommitCountUnknown',
        'uncommittedChangeCount',
        'uncommittedChangeCountUnknown',
        'remoteOrigin',
      ].sort(),
    );
  });
});

describe('parseRemoteOriginUrl — host/path だけを取り出す（userinfo・クエリ・フラグメント・資格は落とす。Issue #1376 B2）', () => {
  it('userinfo（トークン形）を落とす: https://<token>@host/path', () => {
    expect(parseRemoteOriginUrl('https://ghp_abc123XYZ@github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('userinfo（user:pass 形）を落とす: https://user:pass@host/path', () => {
    expect(parseRemoteOriginUrl('https://user:pass@github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('userinfo（ssh scheme 形）を落とす: ssh://git@host/path', () => {
    expect(parseRemoteOriginUrl('ssh://git@github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('scp 形式（git@host:owner/repo.git）も host/path だけにする', () => {
    expect(parseRemoteOriginUrl('git@github.com:acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('scp 形式で userinfo に "@" が2個以上（壊れた／細工された入力）なら undefined（host に断片を漏らさない）', () => {
    expect(parseRemoteOriginUrl('tok@en@github.com:acme/w.git')).toBeUndefined();
  });

  it('scp 形式でもクエリ文字列を落とす', () => {
    expect(parseRemoteOriginUrl('git@github.com:acme/widgets.git?token=abc123XYZ')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('scp 形式でもフラグメントを落とす', () => {
    expect(parseRemoteOriginUrl('git@github.com:acme/widgets.git#readme')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('クエリ文字列（?token=…）を落とす', () => {
    expect(parseRemoteOriginUrl('https://github.com/acme/widgets.git?token=abc123XYZ')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('フラグメントを落とす', () => {
    expect(parseRemoteOriginUrl('https://github.com/acme/widgets.git#readme')).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
  });

  it('落とせない・解釈できない形は undefined（値を作らない。生の文字列は出さない）', () => {
    expect(parseRemoteOriginUrl('')).toBeUndefined();
    expect(parseRemoteOriginUrl('   ')).toBeUndefined();
    expect(parseRemoteOriginUrl('/local/bare/repo.git')).toBeUndefined();
    expect(parseRemoteOriginUrl('not a url at all')).toBeUndefined();
  });
});

describe('computeUnpushedWork — remoteOrigin（origin の host/path。Issue #1376 B2）', () => {
  it('origin remote の URL から userinfo を落とした host/path を返す', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');
    git(root, ['remote', 'add', 'origin', 'https://ghp_secretToken@github.com/acme/widgets.git']);

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees[0]?.remoteOrigin).toEqual({
      host: 'github.com',
      path: 'acme/widgets.git',
    });
    expect(JSON.stringify(result)).not.toContain('ghp_secretToken');
  });

  it('origin remote が無ければ remoteOrigin は省かれる（0 と混ぜない）', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees[0]?.remoteOrigin).toBeUndefined();
  });

  it('origin remote の URL が解釈できない形なら remoteOrigin は省かれ、生の文字列も出ない', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');
    git(root, ['remote', 'add', 'origin', 'not a url at all']);

    const result = await computeUnpushedWork(root, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees[0]?.remoteOrigin).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('not a url at all');
  });
});

describe('computeUnpushedWork — Issue #1067（他人の作業ツリーで git を撃つ）', () => {
  it('起こす全ての git 呼び出しの env に GIT_OPTIONAL_LOCKS=0 と GIT_TERMINAL_PROMPT=0 が載る', async () => {
    initRepo(join(root, 'r1'));
    commitFile(join(root, 'r1'), 'a.txt', 'x\n', 'x');
    initRepo(join(root, 'r2'));
    commitFile(join(root, 'r2'), 'a.txt', 'x\n', 'x');

    const recordedEnvs: Record<string, string | undefined>[] = [];
    const spyingSpawn: ProcessSpawnFn = (options) => {
      recordedEnvs.push(options.env);
      return realSpawn(options);
    };

    await computeUnpushedWork(root, { spawn: spyingSpawn, env: gitChildEnv() });

    expect(recordedEnvs.length).toBeGreaterThanOrEqual(6);
    for (const env of recordedEnvs) {
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    }
  });
});

describe('computeUnpushedWork — git を起こせない（pids が尽きて fork が EAGAIN で断られる。Issue #1266）', () => {
  it('作業ツリーは見つけたまま、件数は「git を起こせなかった: EAGAIN」と名乗り、「HEAD が無効」とは言わない', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');

    const forkRefusedSpawn: ProcessSpawnFn = () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' })),
      );
      return child;
    };

    const result = await computeUnpushedWork(root, { spawn: forkRefusedSpawn, env: gitChildEnv() });

    expect(result.worktrees).toHaveLength(1);
    const tree = result.worktrees[0];
    expect(tree?.branch).toBeNull();
    expect(tree?.unpushedCommitCountUnknown).toBe(
      '確かめられなかった（git を起こせなかった: EAGAIN）',
    );
    expect(tree?.uncommittedChangeCountUnknown).toBe(
      '確かめられなかった（git を起こせなかった: EAGAIN）',
    );
  });
});

describe('computeUnpushedWork — タイムアウト', () => {
  it('git コマンドが止まっていても、期限で切り上げて「確かめられなかった」と名乗る', async () => {
    initRepo(root);
    commitFile(root, 'a.txt', 'first\n', 'first');

    const hangingSpawn: ProcessSpawnFn = (options) =>
      spawn('sleep', ['5'], {
        signal: options.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '' },
      });

    const startedAt = Date.now();
    const result = await computeUnpushedWork(root, {
      spawn: hangingSpawn,
      env: gitChildEnv(),
      gitCommandTimeoutMs: 200,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(4_000);
    const tree = result.worktrees[0];
    expect(tree?.unpushedCommitCountUnknown).toContain('タイムアウト');
    expect(tree?.uncommittedChangeCountUnknown).toContain('タイムアウト');
  }, 10_000);
});

describe('computeUnpushedWork — 呼び出し元の期限（signal）', () => {
  it('進行中に abort されたら、残りの作業ツリーも一覧からは落とさず「打ち切った」と名乗る', async () => {
    initRepo(join(root, 'r1'));
    commitFile(join(root, 'r1'), 'a.txt', 'x\n', 'x');
    initRepo(join(root, 'r2'));
    commitFile(join(root, 'r2'), 'a.txt', 'x\n', 'x');

    const controller = new AbortController();
    controller.abort();

    const result = await computeUnpushedWork(root, {
      spawn: realSpawn,
      env: gitChildEnv(),
      signal: controller.signal,
    });

    expect(result.worktrees).toHaveLength(2);
    expect(result.stoppedEarly).toBe(true);
    for (const tree of result.worktrees) {
      expect(tree.unpushedCommitCountUnknown).toBeDefined();
    }
  });
});

describe('matchesManagerScratchDirName — /tmp 直下の名前を委譲の id と結び付ける当てはめ規則（Issue #1376 の続き）', () => {
  it.each([
    ['mgr-c654', 'mgr-c654e049-abcdefgh'],
    ['mgr-c654e049', 'mgr-c654e049-abcdefgh'],
    ['mgr-c654-scratch', 'mgr-c654e049-abcdefgh'],
    ['mgr-abcd1234', 'mgr-abcd1234-xxxxxxxx'],
  ])('%s は委譲 %s に当たる', (dirName, managerId) => {
    expect(matchesManagerScratchDirName(dirName, managerId)).toBe(true);
  });

  it.each([
    ['mgr-e195ae40', 'mgr-c654e049-abcdefgh'],
    ['mgr-c65', 'mgr-c654e049-abcdefgh'],
    ['mgr-abc', 'mgr-abcd1234-xxxxxxxx'],
    ['other', 'mgr-c654e049-abcdefgh'],
    ['mgra-c654', 'mgr-c654e049-abcdefgh'],
    ['mgr-XYZW', 'mgr-c654e049-abcdefgh'],
  ])('%s は委譲 %s に当たらない', (dirName, managerId) => {
    expect(matchesManagerScratchDirName(dirName, managerId)).toBe(false);
  });
});

describe('findManagerScratchRoots', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTempDirSync('alteroid-unpushed-work-scratch-');
  });

  it('当たったディレクトリだけを絶対パスで返す（対照: 別の委譲・名前が当たらない場所・16進4文字未満は含まない）', async () => {
    mkdirSync(join(tmpRoot, 'mgr-abcd'));
    mkdirSync(join(tmpRoot, 'mgr-abcd1234'));
    mkdirSync(join(tmpRoot, 'mgr-ffff'));
    mkdirSync(join(tmpRoot, 'other'));
    mkdirSync(join(tmpRoot, 'mgr-abc'));

    const found = await findManagerScratchRoots(tmpRoot, 'mgr-abcd1234-xxxxxxxx');

    expect(found.unknownReason).toBeUndefined();
    expect([...found.paths].sort()).toEqual(
      [join(tmpRoot, 'mgr-abcd'), join(tmpRoot, 'mgr-abcd1234')].sort(),
    );
  });

  it('当たらなかったディレクトリの中へは降りない（stat もしない）', async () => {
    initRepo(join(tmpRoot, 'other', 'repo'));

    const found = await findManagerScratchRoots(tmpRoot, 'mgr-abcd1234-xxxxxxxx');

    expect(found).toEqual({ paths: [] });
  });

  it('当たらないディレクトリの奥に在る一致名も拾わない（/tmp 全体を再帰しない）', async () => {
    mkdirSync(join(tmpRoot, 'other', 'mgr-abcd'), { recursive: true });

    const found = await findManagerScratchRoots(tmpRoot, 'mgr-abcd1234-xxxxxxxx');

    expect(found).toEqual({ paths: [] });
  });

  it('⭐ tmpRootDir を読めなければ、paths を空にしたまま unknownReason に理由を残す（黙って諦めない）', async () => {
    const found = await findManagerScratchRoots(
      join(tmpRoot, 'does-not-exist'),
      'mgr-abcd1234-xxxxxxxx',
    );

    expect(found.paths).toEqual([]);
    expect(found.unknownReason).toBeDefined();
    expect(found.unknownReason).toContain('確かめられなかった');
  });
});

describe('computeUnpushedWork — 探索の起点に /tmp のスクラッチディレクトリを足す（managerId。Issue #1376 / #1266 の続き）', () => {
  let tmpRoot: string;
  let cwd: string;
  const managerId = 'mgr-abcd1234-abcdefgh';

  beforeEach(() => {
    tmpRoot = makeTempDirSync('alteroid-unpushed-work-scratch-');
    cwd = makeTempDirSync('alteroid-unpushed-work-cwd-');
  });

  it('陽性: 委譲 id に当たる /tmp 直下のディレクトリの下の clone と worktree が両方観測に載る', async () => {
    initRepo(join(tmpRoot, 'mgr-abcd', 'repo'));
    commitFile(join(tmpRoot, 'mgr-abcd', 'repo'), 'a.txt', 'x\n', 'x');
    initRepo(join(tmpRoot, 'mgr-abcd', 'wt-1'));
    commitFile(join(tmpRoot, 'mgr-abcd', 'wt-1'), 'a.txt', 'x\n', 'x');

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: tmpRoot,
    });

    const paths = result.worktrees.map((wt) => wt.relativePath).sort();
    expect(paths).toEqual(
      [join(tmpRoot, 'mgr-abcd', 'repo'), join(tmpRoot, 'mgr-abcd', 'wt-1')].sort(),
    );
  });

  it('対照: 別の委譲の場所・名前が当たらない場所・16進4文字未満の場所は1本も載らない', async () => {
    initRepo(join(tmpRoot, 'mgr-ffff', 'repo'));
    commitFile(join(tmpRoot, 'mgr-ffff', 'repo'), 'a.txt', 'x\n', 'x');
    initRepo(join(tmpRoot, 'other', 'repo'));
    commitFile(join(tmpRoot, 'other', 'repo'), 'a.txt', 'x\n', 'x');
    initRepo(join(tmpRoot, 'mgr-abc', 'repo'));
    commitFile(join(tmpRoot, 'mgr-abc', 'repo'), 'a.txt', 'x\n', 'x');

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: tmpRoot,
    });

    expect(result.worktrees).toHaveLength(0);
  });

  it('managerId を渡さなければ /tmp を一切見ない（この機能を足す前の挙動と変わらない）', async () => {
    initRepo(join(tmpRoot, 'mgr-abcd', 'repo'));
    commitFile(join(tmpRoot, 'mgr-abcd', 'repo'), 'a.txt', 'x\n', 'x');

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      tmpRootDir: tmpRoot,
    });

    expect(result.worktrees).toHaveLength(0);
  });

  it('重複: job.cwd 自体が /tmp のスクラッチディレクトリの中に在るとき、同じツリーを2回数えない', async () => {
    const nestedCwd = join(tmpRoot, 'mgr-abcd', 'repo');
    initRepo(nestedCwd);
    commitFile(nestedCwd, 'a.txt', 'x\n', 'x');

    const result = await computeUnpushedWork(nestedCwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: tmpRoot,
    });

    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]?.relativePath).toBe('.');
  });

  it('出力パス: cwd の外で見つかったツリーは絶対パス、cwd の下は相対パスのまま', async () => {
    initRepo(cwd);
    commitFile(cwd, 'a.txt', 'x\n', 'x');
    initRepo(join(tmpRoot, 'mgr-abcd', 'repo'));
    commitFile(join(tmpRoot, 'mgr-abcd', 'repo'), 'a.txt', 'x\n', 'x');

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: tmpRoot,
    });

    const paths = result.worktrees.map((wt) => wt.relativePath).sort();
    expect(paths).toEqual(['.', join(tmpRoot, 'mgr-abcd', 'repo')].sort());
  });

  it('件数上限（truncatedAtCount）は起点をまたいで全体に効く', async () => {
    initRepo(join(cwd, 'r1'));
    commitFile(join(cwd, 'r1'), 'a.txt', 'x\n', 'x');
    initRepo(join(cwd, 'r2'));
    commitFile(join(cwd, 'r2'), 'a.txt', 'x\n', 'x');
    initRepo(join(tmpRoot, 'mgr-abcd', 'r3'));
    commitFile(join(tmpRoot, 'mgr-abcd', 'r3'), 'a.txt', 'x\n', 'x');
    initRepo(join(tmpRoot, 'mgr-abcd', 'r4'));
    commitFile(join(tmpRoot, 'mgr-abcd', 'r4'), 'a.txt', 'x\n', 'x');

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: tmpRoot,
      maxWorktrees: 3,
    });

    expect(result.worktrees).toHaveLength(3);
    expect(result.truncatedAtCount).toBe(3);
  });

  it('⭐ /tmp のスクラッチディレクトリを確かめられなかったら、0本と混ぜずに scratchRootsUnknown で名乗る', async () => {
    const unreadableTmpRoot = join(tmpRoot, 'does-not-exist');

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: unreadableTmpRoot,
    });

    expect(result.worktrees).toHaveLength(0);
    expect(result.scratchRootsUnknown).toBeDefined();
    expect(result.scratchRootsUnknown).toContain('確かめられなかった');
  });

  it('managerId を渡さなければ、tmpRootDir が読めなくても scratchRootsUnknown は載らない（この探索自体を行っていない）', async () => {
    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      tmpRootDir: join(tmpRoot, 'does-not-exist'),
    });

    expect(result.scratchRootsUnknown).toBeUndefined();
  });
});

describe('computeUnpushedWork — 探索の起点（job.cwd）自体が読めない（Issue #1826）', () => {
  it('起点（job.cwd）が存在しない（ENOENT）とき、0本と混ぜずに例外で「確かめられなかった」を運ぶ', async () => {
    const missingCwd = join(makeTempDirSync('alteroid-unpushed-work-missing-'), 'does-not-exist');

    await expect(
      computeUnpushedWork(missingCwd, { spawn: realSpawn, env: gitChildEnv() }),
    ).rejects.toThrow();
  });

  it('起点（job.cwd）に読み取り権限が無い（EACCES）とき、0本と混ぜずに例外で「確かめられなかった」を運ぶ', async () => {
    const lockedCwd = join(makeTempDirSync('alteroid-unpushed-work-locked-'), 'locked');
    mkdirSync(lockedCwd, { recursive: true });
    chmodSync(lockedCwd, 0o000);
    try {
      const readableAsRoot = (() => {
        try {
          readdirSync(lockedCwd);
          return true;
        } catch {
          return false;
        }
      })();

      if (readableAsRoot) {
        const result = await computeUnpushedWork(lockedCwd, {
          spawn: realSpawn,
          env: gitChildEnv(),
        });
        expect(result.worktrees).toHaveLength(0);
      } else {
        await expect(
          computeUnpushedWork(lockedCwd, { spawn: realSpawn, env: gitChildEnv() }),
        ).rejects.toThrow();
      }
    } finally {
      chmodSync(lockedCwd, 0o755);
    }
  });

  it('起点より下（子ディレクトリ）の読み失敗があっても、見つかった分（visible）はそのまま返す', async () => {
    const top = makeTempDirSync('alteroid-unpushed-work-nested-locked-');
    initRepo(join(top, 'visible'));
    commitFile(join(top, 'visible'), 'a.txt', 'x\n', 'x');
    const lockedChild = join(top, 'locked-child');
    mkdirSync(lockedChild, { recursive: true });
    chmodSync(lockedChild, 0o000);
    try {
      const result = await computeUnpushedWork(top, { spawn: realSpawn, env: gitChildEnv() });
      expect(result.worktrees.map((wt) => wt.relativePath)).toEqual(['visible']);
    } finally {
      chmodSync(lockedChild, 0o755);
    }
  });
});

describe('computeUnpushedWork — 起点より下（子ディレクトリ）の読み失敗を数える（Issue #1865）', () => {
  it('⭐ 子ディレクトリの読み失敗が UnpushedWorkResult.unreadableDirCount に載る', async () => {
    const top = makeTempDirSync('alteroid-unpushed-work-child-unreadable-');
    initRepo(join(top, 'visible'));
    commitFile(join(top, 'visible'), 'a.txt', 'x\n', 'x');
    const brokenChild = join(top, 'broken-child');
    mkdirSync(brokenChild, { recursive: true });

    const readdirFn: ReaddirFn = async (dir) => {
      if (dir === brokenChild) {
        throw Object.assign(new Error('EACCES: permission denied, scandir (テスト用の模擬失敗)'), {
          code: 'EACCES',
        });
      }
      return readdir(dir, { withFileTypes: true });
    };

    const result = await computeUnpushedWork(top, {
      spawn: realSpawn,
      env: gitChildEnv(),
      readdirFn,
    });

    expect(result.worktrees.map((wt) => wt.relativePath)).toEqual(['visible']);
    expect(result.unreadableDirCount).toBe(1);
    expect(result.unreadableDirSample).toContain(brokenChild);
  });

  it('対照: すべての子ディレクトリが読めるときは unreadableDirCount が省略される', async () => {
    const top = makeTempDirSync('alteroid-unpushed-work-all-readable-');
    initRepo(join(top, 'visible'));
    commitFile(join(top, 'visible'), 'a.txt', 'x\n', 'x');
    mkdirSync(join(top, 'plain-child'), { recursive: true });

    const result = await computeUnpushedWork(top, { spawn: realSpawn, env: gitChildEnv() });

    expect(result.worktrees.map((wt) => wt.relativePath)).toEqual(['visible']);
    expect(result.unreadableDirCount).toBeUndefined();
    expect(result.unreadableDirSample).toBeUndefined();
  });

  it('unpushedWorkResultSchema がパースを受け付ける（スキーマ側にも足したことの固定）', async () => {
    const top = makeTempDirSync('alteroid-unpushed-work-schema-');
    initRepo(join(top, 'visible'));
    const brokenChild = join(top, 'broken-child');
    mkdirSync(brokenChild, { recursive: true });
    const readdirFn: ReaddirFn = async (dir) => {
      if (dir === brokenChild) throw new Error('模擬失敗');
      return readdir(dir, { withFileTypes: true });
    };

    const result = await computeUnpushedWork(top, {
      spawn: realSpawn,
      env: gitChildEnv(),
      readdirFn,
    });

    expect(unpushedWorkResultSchema.safeParse(result).success).toBe(true);
  });
});

describe('computeUnpushedWork — 2本目以降の起点（/tmp スクラッチ）自体の読み失敗を数える（Issue #1891）', () => {
  it('⭐ スクラッチ起点自体（2本目以降）が readdir できないとき、0本と混ぜずに unreadableDirCount に数える', async () => {
    const tmpRoot = makeTempDirSync('alteroid-unpushed-work-scratch-root-unreadable-');
    const cwd = makeTempDirSync('alteroid-unpushed-work-cwd-');
    const managerId = 'mgr-abcd1234-abcdefgh';
    const scratchRoot = join(tmpRoot, 'mgr-abcd');
    mkdirSync(scratchRoot, { recursive: true });

    const readdirFn: ReaddirFn = async (dir) => {
      if (dir === scratchRoot) {
        throw Object.assign(new Error('EACCES: permission denied, scandir (テスト用の模擬失敗)'), {
          code: 'EACCES',
        });
      }
      return readdir(dir, { withFileTypes: true });
    };

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: tmpRoot,
      readdirFn,
    });

    expect(result.worktrees).toHaveLength(0);
    expect(result.unreadableDirCount).toBeGreaterThanOrEqual(1);
    expect(result.unreadableDirSample).toContain(scratchRoot);
    expect(result.scratchRootsUnknown).toBeUndefined();
  });

  it('対照: スクラッチ起点が読めるときは、これまでどおり unreadableDirCount は省略される', async () => {
    const tmpRoot = makeTempDirSync('alteroid-unpushed-work-scratch-root-readable-');
    const cwd = makeTempDirSync('alteroid-unpushed-work-cwd-');
    const managerId = 'mgr-abcd1234-abcdefgh';
    initRepo(join(tmpRoot, 'mgr-abcd', 'repo'));
    commitFile(join(tmpRoot, 'mgr-abcd', 'repo'), 'a.txt', 'x\n', 'x');

    const result = await computeUnpushedWork(cwd, {
      spawn: realSpawn,
      env: gitChildEnv(),
      managerId,
      tmpRootDir: tmpRoot,
    });

    expect(result.worktrees.map((wt) => wt.relativePath)).toEqual([
      join(tmpRoot, 'mgr-abcd', 'repo'),
    ]);
    expect(result.unreadableDirCount).toBeUndefined();
    expect(result.unreadableDirSample).toBeUndefined();
  });
});

describe('未push観測の reason は伏せ字を通す（#2607）', () => {
  const BEARER = 'Bearer sk-FAKE0123456789abcdefSECRET';
  const URL_CRED = 'https://user:hunter2-FAKE-pass@example.com/repo.git';

  it('起点の readdir 失敗の理由（rootUnreadable）に資格を残さない', async () => {
    const readdirFn: ReaddirFn = async () => {
      throw new Error(`EACCES: ${BEARER} が漏れる模擬`);
    };
    const found = await findGitDirs('/fake-root', { readdirFn });
    expect(found.rootUnreadable).toBeDefined();
    expect(found.rootUnreadable).not.toContain('sk-FAKE0123456789abcdefSECRET');
  });

  it('子ディレクトリの readdir 失敗のサンプル（unreadableDirSample）に資格を残さない', async () => {
    const readdirFn: ReaddirFn = async (dir) => {
      if (dir === '/fake-root') return [{ name: 'child', isDirectory: () => true }];
      throw new Error(`failed to read ${URL_CRED}`);
    };
    const found = await findGitDirs('/fake-root', { readdirFn });
    expect(found.unreadableDirCount).toBe(1);
    expect(found.unreadableDirSample).toContain('/fake-root/child');
    expect(found.unreadableDirSample).not.toContain('hunter2-FAKE-pass');
  });

  it('tmpRootDir の readdir 失敗の理由（unknownReason）に資格を残さない', async () => {
    const readdirFn: ReaddirFn = async () => {
      throw new Error(`EACCES: ${BEARER}`);
    };
    const found = await findManagerScratchRoots('/fake-tmp', 'mgr-abcd1234-xxxxxxxx', {
      readdirFn,
    });
    expect(found.unknownReason).toContain('確かめられなかった');
    expect(found.unknownReason).not.toContain('sk-FAKE0123456789abcdefSECRET');
  });
});
