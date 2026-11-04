import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteRescueRef, RescueMemory, runRescue } from './rescue-ref.js';
import type { ProcessSpawnFn } from './unpushed-work.js';

// `rescue-ref.ts` の `git()` と `streamGit()` に写しで在る「期限と中断の仕掛け」の振る舞いを、公開の関数越しに固定する。
// `git()` は `deleteRescueRef`、`streamGit()` は `runRescue` の `cat-file blob` の読みを通して観測する。
// 子プロセスは、渡された signal が中断されたら exit 0 で閉じる: 終了コードで失敗にならないので、
// 失敗に見えるのは `timedOut`・`overflow` の旗が立ったときだけになる。

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

const GIT_TIMEOUT_MS = 20_000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;

interface Behavior {
  readonly stdout?: readonly Buffer[];
  readonly hang?: boolean;
  /** 子の spawn 直後（同期の続きが終わった直後）に呼ぶ。 */
  readonly afterSpawn?: () => void;
}

function fakeChild(signal: AbortSignal, behavior: Behavior): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    child.emit('close', 0);
  };
  if (behavior.hang === true) {
    if (signal.aborted) setImmediate(close);
    else signal.addEventListener('abort', () => setImmediate(close), { once: true });
  }
  setImmediate(() => {
    for (const chunk of behavior.stdout ?? []) child.stdout.emit('data', chunk);
    if (behavior.hang !== true) close();
  });
  if (behavior.afterSpawn !== undefined) queueMicrotask(behavior.afterSpawn);
  return child as unknown as ChildProcess;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: string[];
  readonly signal: AbortSignal;
  readonly abortedAtSpawn: boolean;
}

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

const COMMIT = 'a'.repeat(40);
const REF = 'refs/alteroid-rescue/mgr-1/wt-1';

describe('git()（deleteRescueRef 越し）の期限と中断', () => {
  let records: SpawnRecord[];

  // `rm`（後始末）は呼び手の signal を持たない別の呼び出しなので、既定で普通に終わらせる。
  const makeSpawn =
    (forInit: (index: number, signal: AbortSignal) => Behavior): ProcessSpawnFn =>
    (o) => {
      records.push({
        command: o.command,
        args: o.args,
        signal: o.signal,
        abortedAtSpawn: o.signal.aborted,
      });
      if (o.command === 'rm') return fakeChild(o.signal, {});
      const index = records.filter((r) => r.command !== 'rm').length - 1;
      return fakeChild(o.signal, forInit(index, o.signal));
    };

  const del = (spawnFn: ProcessSpawnFn, signal?: AbortSignal) =>
    deleteRescueRef({
      spawn: spawnFn,
      env: GIT_ENV,
      remote: '/nonexistent/origin.git',
      ref: REF,
      commit: COMMIT,
      tmpRootDir: '/nonexistent/tmp-root',
      allowLocalRemote: true,
      ...(signal === undefined ? {} : { signal }),
    });
  const nonRm = (): SpawnRecord[] => records.filter((r) => r.command !== 'rm');

  beforeEach(() => {
    records = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. ふつうに終わる: 失敗にせず、次の git へ進む', async () => {
    const result = await del(makeSpawn(() => ({})));

    expect(result).toEqual({ outcome: 'removed', alreadyGone: false });
    expect(nonRm().map((r) => r.args[0])).toEqual(['init', expect.stringContaining('--git-dir=')]);
    expect(nonRm().every((r) => !r.abortedAtSpawn && !r.signal.aborted)).toBe(true);
  });

  it('2. 呼び手の signal が呼ぶ前から中断済み: spawn に渡る signal も中断済みで、timeout になる', async () => {
    const caller = new AbortController();
    caller.abort();

    const result = await del(
      makeSpawn(() => ({ hang: true })),
      caller.signal,
    );

    expect(result).toEqual({ outcome: 'failed', kind: 'timeout' });
    expect(nonRm()).toHaveLength(1);
    expect(nonRm()[0]?.abortedAtSpawn).toBe(true);
    // 後始末の rm は呼び手の signal を引き継がない
    const rm = records.find((r) => r.command === 'rm');
    expect(rm?.abortedAtSpawn).toBe(false);
  });

  it('3. 呼び手が途中で中断する: timeout になる', async () => {
    const caller = new AbortController();

    const result = await del(
      makeSpawn(() => ({ hang: true, afterSpawn: () => caller.abort() })),
      caller.signal,
    );

    expect(result).toEqual({ outcome: 'failed', kind: 'timeout' });
    expect(nonRm()).toHaveLength(1);
    expect(nonRm()[0]?.abortedAtSpawn).toBe(false);
    expect(nonRm()[0]?.signal.aborted).toBe(true);
  });

  it('4. 期限が切れる: timeout になり、spawn の signal が中断される', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const result = await del(
      makeSpawn(() => ({ hang: true, afterSpawn: () => vi.advanceTimersByTime(GIT_TIMEOUT_MS) })),
    );

    expect(result).toEqual({ outcome: 'failed', kind: 'timeout' });
    expect(nonRm()).toHaveLength(1);
    expect(nonRm()[0]?.signal.aborted).toBe(true);
  });

  it('5. 出力が上限を超える: 失敗（overflow）として次の git へ進まない', async () => {
    const big = Buffer.alloc(LIST_MAX_BYTES + 1, 0x61);

    const result = await del(makeSpawn(() => ({ hang: true, stdout: [big] })));

    // timedOut ではないので timeout にならず other。exit 0 でも overflow で ok にならない
    expect(result).toEqual({ outcome: 'failed', kind: 'other' });
    expect(nonRm()).toHaveLength(1);
    expect(nonRm()[0]?.signal.aborted).toBe(true);
  });

  it('6. 後始末: 終わった後に呼び手が abort しても、spawn の signal は動かない（受け手が外れている）', async () => {
    const caller = new AbortController();

    const result = await del(
      makeSpawn(() => ({})),
      caller.signal,
    );
    expect(result).toEqual({ outcome: 'removed', alreadyGone: false });
    caller.abort();

    expect(nonRm()).toHaveLength(2);
    expect(nonRm().every((r) => !r.signal.aborted)).toBe(true);
  });
});

describe('streamGit()（runRescue の cat-file blob 越し）の期限と中断', () => {
  let root: string;
  let repo: string;
  let bare: string;
  let records: SpawnRecord[];
  const managerId = 'mgr-abcd1234-0000-0000-0000-000000000000';

  const png = (body: string): Buffer =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
      Buffer.from(`IHDR\0\n${body}\n\0IDAT\0\n`, 'latin1'),
    ]);

  // `cat-file` だけを偽の子に差し替え、ほかの git は本物を使う。
  const run = (catFile: Behavior, extra: Partial<Parameters<typeof runRescue>[1]> = {}) => {
    const spawnFn: ProcessSpawnFn = (o) => {
      records.push({
        command: o.command,
        args: o.args,
        signal: o.signal,
        abortedAtSpawn: o.signal.aborted,
      });
      if (o.args[0] === 'cat-file') return fakeChild(o.signal, catFile);
      return realSpawn(o);
    };
    return runRescue(repo, {
      managerId,
      spawn: spawnFn,
      env: { ...GIT_ENV, GH_TOKEN: 'x' },
      memory: new RescueMemory(),
      tmpRootDir: path.join(root, 'no-tmp'),
      ...extra,
    });
  };
  const sawCommitTree = (): boolean => records.some((r) => r.args[0] === 'commit-tree');
  const catFileRecords = (): SpawnRecord[] => records.filter((r) => r.args[0] === 'cat-file');

  beforeEach(async () => {
    records = [];
    root = await makeTempDir('rescue-git-deadline-pin-');
    repo = path.join(root, 'repo');
    bare = path.join(root, 'origin.git');
    await mkdir(repo);
    g(root, 'init', '-q', '--bare', bare);
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'remote', 'add', 'origin', bare);
    g(bare, 'config', 'receive.autogc', 'false');
    g(bare, 'config', 'gc.auto', '0');
    g(repo, 'config', 'gc.auto', '0');
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-qm', 'first');
    g(repo, 'push', '-q', 'origin', 'main');
    g(repo, 'fetch', '-q', 'origin');
    // 未 push のバイナリ: `cat-file blob` で読まれる
    await writeFile(path.join(repo, 'art.png'), png('x'.repeat(100)));
    g(repo, 'add', 'art.png');
    g(repo, 'commit', '-qm', 'png');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('1. ふつうに終わる: 塊を読み終えて先へ進み、退避を送る', async () => {
    const [report] = await run({ stdout: [Buffer.from('harmless body')] });

    expect(report?.notPushed).toBeUndefined();
    expect(report?.pushed?.ref).toBeDefined();
    expect(catFileRecords()).toHaveLength(1);
    expect(sawCommitTree()).toBe(true);
  });

  // 道2（呼び手の signal が呼ぶ前から中断済み）は作らない: runRescue は中断済みなら作業ツリーに入る前に止まり、
  // 手前の git() も同じ signal で失敗するため、streamGit を中断済みの signal で呼ぶ道は公開の関数から作れない。

  it('3. 呼び手が途中で中断する: 失敗として止まり、先の git へ進まない', async () => {
    const caller = new AbortController();

    const [report] = await run(
      { hang: true, afterSpawn: () => caller.abort() },
      { signal: caller.signal },
    );

    expect(report?.notPushed?.reason).toBe('timeout');
    expect(catFileRecords()).toHaveLength(1);
    expect(catFileRecords()[0]?.abortedAtSpawn).toBe(false);
    expect(catFileRecords()[0]?.signal.aborted).toBe(true);
    expect(sawCommitTree()).toBe(false);
  });

  it('4. 期限が切れる: 失敗（error）として止まり、先の git へ進まない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const [report] = await run({
      hang: true,
      afterSpawn: () => vi.advanceTimersByTime(GIT_TIMEOUT_MS),
    });

    expect(report?.notPushed?.reason).toBe('error');
    expect(catFileRecords()).toHaveLength(1);
    expect(catFileRecords()[0]?.signal.aborted).toBe(true);
    expect(sawCommitTree()).toBe(false);
  });

  it('5. 出力が上限を超える: too-large として止まる', async () => {
    const [report] = await run(
      { hang: true, stdout: [Buffer.alloc(2000, 0x61)] },
      { binaryBlobMaxBytes: 1000 },
    );

    expect(report?.notPushed?.reason).toBe('too-large');
    expect(catFileRecords()[0]?.signal.aborted).toBe(true);
    expect(sawCommitTree()).toBe(false);
  });

  it('6. 後始末: 終わった後に呼び手が abort しても、spawn の signal は動かない', async () => {
    const caller = new AbortController();

    const [report] = await run(
      { stdout: [Buffer.from('harmless body')] },
      { signal: caller.signal },
    );
    expect(report?.notPushed).toBeUndefined();
    caller.abort();

    expect(catFileRecords()).toHaveLength(1);
    expect(records.length).toBeGreaterThan(1);
    expect(records.every((r) => !r.signal.aborted)).toBe(true);
  });
});
