import type { ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { reasonOf } from './dropped-record.js';
import type { UnpushedWorkResult, UnpushedWorkTree } from './runner-protocol.js';

// 「未 push」を `@{u}` で数えない: upstream 未設定の枝（一度も push されていない枝）を見落とすため
// fetch も `git ls-remote` もしない: ネットワークを一切使わない。fetch していない remote-tracking ref が基準なので push 済みを未 push と多めに数えうるが、失われるものを多めに言う安全側の誤りのため許す
// ファイル名・差分の中身・コミットメッセージ・author を出さない。origin の URL は host と path だけにする（userinfo・クエリ・フラグメントを出さない。解釈できない形は値ごと省く）
export type ProcessSpawnFn = (options: {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}) => ChildProcess;

// readdir を差し替え可能にする: `chmod 000` は root で走る CI では効かず、権限に触れずに読み失敗を再現するため
export interface DirEntryLike {
  readonly name: string;
  isDirectory(): boolean;
}

export type ReaddirFn = (dir: string) => Promise<readonly DirEntryLike[]>;

const defaultReaddirFn: ReaddirFn = (dir) => readdir(dir, { withFileTypes: true });

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_WORKTREES = 20;
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 3_000;

// 起点そのものの読み失敗を別の欄で名乗る: 見つかった分だけを正としてよいという前提が崩れ、0本と探索できなかったが同じ形になるため
// 子ディレクトリの読み失敗は黙って諦めるが件数は数える: 0本と見分けが付かず、自動畳みの安全弁が未 push の実装を見落とすため
export interface FindGitDirsResult {
  readonly paths: readonly string[];
  readonly truncatedAtCount?: number;
  readonly rootUnreadable?: string;
  readonly unreadableDirCount?: number;
  readonly unreadableDirSample?: string;
  readonly depthLimitedCount?: number;
  readonly depthLimitedSample?: string;
}

export async function findGitDirs(
  root: string,
  options: {
    maxDepth?: number;
    maxCount?: number;
    readdirFn?: ReaddirFn;
    reportDepthLimit?: boolean;
  } = {},
): Promise<FindGitDirsResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCount = options.maxCount ?? DEFAULT_MAX_WORKTREES;
  const readdirFn = options.readdirFn ?? defaultReaddirFn;
  const found: string[] = [];
  let truncated = false;
  let rootUnreadable: string | undefined;
  let unreadableDirCount = 0;
  let unreadableDirSample: string | undefined;
  let depthLimitedCount = 0;
  let depthLimitedSample: string | undefined;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdirFn(dir);
    } catch (error) {
      if (dir === root) {
        rootUnreadable = reasonOf(error);
      } else {
        unreadableDirCount += 1;
        if (unreadableDirSample === undefined) {
          unreadableDirSample = `${dir}: ${reasonOf(error)}`;
        }
      }
      return;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === 'node_modules') continue;
      if (entry.name === '.git') {
        found.push(dir);
        if (found.length >= maxCount) {
          truncated = true;
          return;
        }
        continue;
      }
      if (entry.isDirectory()) subdirs.push(entry.name);
    }
    if (depth >= maxDepth) {
      if (options.reportDepthLimit === true && subdirs.length > 0) {
        depthLimitedCount += subdirs.length;
        depthLimitedSample ??= path.join(dir, subdirs[0] ?? '');
      }
      return;
    }
    for (const name of subdirs) {
      if (truncated) return;
      await walk(path.join(dir, name), depth + 1);
    }
  }

  await walk(root, 0);
  if (rootUnreadable !== undefined) return { paths: found, rootUnreadable };
  return {
    paths: found,
    ...(truncated ? { truncatedAtCount: maxCount } : {}),
    ...(unreadableDirCount > 0 ? { unreadableDirCount, unreadableDirSample } : {}),
    ...(depthLimitedCount > 0 ? { depthLimitedCount, depthLimitedSample } : {}),
  };
}

const MANAGER_SCRATCH_DIR_NAME_PATTERN = /^mgr-([0-9a-f]{4,})/;

// `os.tmpdir()` を使わない: 担い手は文字どおりの `/tmp/mgr-<id の先頭>` に作業場を作り、runner の `TMPDIR` が別の場所を指していても探す先は `/tmp` でなければ当たらないため
const MANAGER_SCRATCH_TMP_ROOT = '/tmp';

export function matchesManagerScratchDirName(name: string, managerId: string): boolean {
  const match = MANAGER_SCRATCH_DIR_NAME_PATTERN.exec(name);
  if (match === null) return false;
  const hex = match[1];
  if (hex === undefined) return false;
  return managerId.startsWith(`mgr-${hex}`);
}

export function isManagerScratchDirName(name: string): boolean {
  return MANAGER_SCRATCH_DIR_NAME_PATTERN.test(name);
}

export interface FindManagerScratchRootsResult {
  readonly paths: readonly string[];
  readonly unknownReason?: string;
}

// `tmpRootDir` を読めなければ空配列へ畳まず理由を残す: 呼び出し側が「未 push の実装は無かった」と読み、確かめられていないだけのケースを見落とすため
// 当たらなかったエントリの中へは降りない（stat もしない）: `/tmp` 全体を再帰しないため
export async function findManagerScratchRoots(
  tmpRootDir: string,
  managerId: string,
  options: { readdirFn?: ReaddirFn } = {},
): Promise<FindManagerScratchRootsResult> {
  const readdirFn = options.readdirFn ?? defaultReaddirFn;
  let entries;
  try {
    entries = await readdirFn(tmpRootDir);
  } catch (error) {
    const detail = reasonOf(error);
    return {
      paths: [],
      unknownReason: `確かめられなかった（${tmpRootDir} を読めなかった: ${detail}）`,
    };
  }
  const paths = entries
    .filter((entry) => entry.isDirectory() && matchesManagerScratchDirName(entry.name, managerId))
    .map((entry) => path.join(tmpRootDir, entry.name));
  return { paths };
}

// 1本目（job.cwd）の rootUnreadable は部分的な結果を混ぜずに上へ運ぶ: 見つかった分だけを正としてよいという前提が崩れているため
// 2本目以降の rootUnreadable は捨てずに unreadableDirCount へ数える: どちらの欄にも出ないと「探しきって0本だった」と区別が付かないため
async function findGitDirsAcrossRoots(
  roots: readonly string[],
  options: { maxDepth?: number; maxCount?: number; readdirFn?: ReaddirFn },
): Promise<FindGitDirsResult> {
  const maxCount = options.maxCount ?? DEFAULT_MAX_WORKTREES;
  const seen = new Set<string>();
  const found: string[] = [];
  let truncated = false;
  let unreadableDirCount = 0;
  let unreadableDirSample: string | undefined;

  for (const [index, root] of roots.entries()) {
    if (found.length >= maxCount) {
      truncated = true;
      break;
    }
    const remaining = maxCount - found.length;
    const result = await findGitDirs(root, {
      maxDepth: options.maxDepth,
      maxCount: remaining,
      readdirFn: options.readdirFn,
    });
    if (index === 0 && result.rootUnreadable !== undefined) {
      return { paths: [], rootUnreadable: result.rootUnreadable };
    }
    if (index !== 0 && result.rootUnreadable !== undefined) {
      unreadableDirCount += 1;
      unreadableDirSample ??= `${root}: ${result.rootUnreadable}`;
    }
    if (result.unreadableDirCount !== undefined) {
      unreadableDirCount += result.unreadableDirCount;
      unreadableDirSample ??= result.unreadableDirSample;
    }
    for (const p of result.paths) {
      const resolved = path.resolve(p);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      found.push(resolved);
    }
    if (result.truncatedAtCount !== undefined) {
      truncated = true;
      break;
    }
  }

  return {
    paths: found,
    ...(truncated ? { truncatedAtCount: maxCount } : {}),
    ...(unreadableDirCount > 0 ? { unreadableDirCount, unreadableDirSample } : {}),
  };
}

export interface GitRunResult {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  // errno の code だけを持つ: message にはパスが混ざりうるため。pids が尽きた器では fork が `EAGAIN` で断られ、exit コードの無い失敗を「HEAD が無効」と読ませないために分ける（#1266）
  readonly spawnFailedCode?: string;
}

function spawnFailedCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : '不明';
}

export async function runGit(
  spawnFn: ProcessSpawnFn,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<GitRunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const child = spawnFn({
      command: 'git',
      args,
      cwd,
      // GIT_OPTIONAL_LOCKS を引数（`--no-optional-locks`）ではなく env に置く: 素の `git status` は他人の生きた作業ツリーの `.git/index` を毎回書き、env なら次に足す git コマンドにも効くため
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      signal: controller.signal,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', () => {
      // stderr は読み捨てる。理由(exit code)は返すが、本文（git のエラー文言に
      // ファイルパスやコミットメッセージの断片が混ざりうる）は外へ出さない。
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    return { stdout, exitCode, timedOut: false };
  } catch (error) {
    return controller.signal.aborted
      ? { stdout: '', exitCode: null, timedOut: true }
      : { stdout: '', exitCode: null, timedOut: false, spawnFailedCode: spawnFailedCodeOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

function gitSpawnFailedText(code: string): string {
  return `確かめられなかった（git を起こせなかった: ${code}）`;
}

async function probeBranch(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string | null> {
  const result = await runGit(
    spawnFn,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoRoot,
    env,
    timeoutMs,
  );
  if (result.timedOut || result.exitCode !== 0) return null;
  const branch = result.stdout.trim();
  // `HEAD` は detached HEAD の印なので枝名として出さない
  return branch.length === 0 || branch === 'HEAD' ? null : branch;
}

async function probeUnpushedCommitCount(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Pick<UnpushedWorkTree, 'unpushedCommitCount' | 'unpushedCommitCountUnknown'>> {
  const result = await runGit(
    spawnFn,
    ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
    repoRoot,
    env,
    timeoutMs,
  );
  if (result.timedOut) {
    return { unpushedCommitCountUnknown: `確かめられなかった（タイムアウト ${timeoutMs}ms）` };
  }
  if (result.spawnFailedCode !== undefined) {
    return { unpushedCommitCountUnknown: gitSpawnFailedText(result.spawnFailedCode) };
  }
  if (result.exitCode !== 0) {
    return {
      unpushedCommitCountUnknown:
        `確かめられなかった（git rev-list が exit ${String(result.exitCode)}——` +
        'HEAD が無効（コミットが一度も無い）である可能性が高い）',
    };
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return {
      unpushedCommitCountUnknown: '確かめられなかった（git の出力を数値として読めなかった）',
    };
  }
  return { unpushedCommitCount: parsed };
}

export function parseRemoteOriginUrl(raw: string): { host: string; path: string } | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.hostname.length === 0) return undefined;
    const path = url.pathname.replace(/^\/+/, '');
    if (path.length === 0) return undefined;
    return { host: url.hostname, path };
  }

  // host の文字クラスから `@` も除く: `@` が2個以上ある入力で userinfo の断片が host へ漏れるため
  const scpMatch = /^(?:[^@\s/]+@)?([^@:\s/]+):(.+)$/.exec(trimmed);
  if (scpMatch !== null) {
    const host = scpMatch[1] ?? '';
    // `?` / `#` 以降を落とす: scp 形式にクエリの構文は無く、`?token=…` のような断片が漏れるため
    const rawPath = (scpMatch[2] ?? '').split(/[?#]/)[0] ?? '';
    const path = rawPath.replace(/^\/+/, '');
    if (host.length > 0 && path.length > 0) {
      return { host, path };
    }
  }

  return undefined;
}

async function probeRemoteOrigin(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ host: string; path: string } | undefined> {
  const result = await runGit(spawnFn, ['remote', 'get-url', 'origin'], repoRoot, env, timeoutMs);
  if (result.timedOut || result.exitCode !== 0) return undefined;
  return parseRemoteOriginUrl(result.stdout.trim());
}

async function probeUncommittedChangeCount(
  spawnFn: ProcessSpawnFn,
  repoRoot: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<Pick<UnpushedWorkTree, 'uncommittedChangeCount' | 'uncommittedChangeCountUnknown'>> {
  const result = await runGit(spawnFn, ['status', '--porcelain'], repoRoot, env, timeoutMs);
  if (result.timedOut) {
    return { uncommittedChangeCountUnknown: `確かめられなかった（タイムアウト ${timeoutMs}ms）` };
  }
  if (result.spawnFailedCode !== undefined) {
    return { uncommittedChangeCountUnknown: gitSpawnFailedText(result.spawnFailedCode) };
  }
  if (result.exitCode !== 0) {
    return {
      uncommittedChangeCountUnknown: `確かめられなかった（git status が exit ${String(result.exitCode)}）`,
    };
  }
  const count = result.stdout.split('\n').filter((line) => line.length > 0).length;
  return { uncommittedChangeCount: count };
}

export interface ComputeUnpushedWorkOptions {
  spawn: ProcessSpawnFn;
  env: Record<string, string | undefined>;
  maxDepth?: number;
  maxWorktrees?: number;
  gitCommandTimeoutMs?: number;
  // 中断しても走っている git コマンドは止めない: 期限は待つのをやめるためだけにあり、見るのは次の作業ツリーへ進む前だけ。残りの作業ツリーも一覧から落とさない
  signal?: AbortSignal;
  managerId?: string;
  tmpRootDir?: string;
  readdirFn?: ReaddirFn;
}

// cwd の外は絶対パスを出す: `..` で始まる相対パスは読みにくいため
function describeWorktreePath(cwd: string, repoRoot: string): string {
  const relativePath = path.relative(cwd, repoRoot);
  if (relativePath.length === 0) return '.';
  if (relativePath.startsWith(`..${path.sep}`) || relativePath === '..') return repoRoot;
  return relativePath;
}

export async function computeUnpushedWork(
  cwd: string,
  options: ComputeUnpushedWorkOptions,
): Promise<UnpushedWorkResult> {
  const scratchRoots: FindManagerScratchRootsResult =
    options.managerId === undefined
      ? { paths: [] }
      : await findManagerScratchRoots(
          options.tmpRootDir ?? MANAGER_SCRATCH_TMP_ROOT,
          options.managerId,
        );
  const found = await findGitDirsAcrossRoots([cwd, ...scratchRoots.paths], {
    maxDepth: options.maxDepth,
    maxCount: options.maxWorktrees,
    readdirFn: options.readdirFn,
  });
  // 新しい欄を足さず例外で運ぶ: cwd が読めないと1本も見ておらず部分的な worktrees すら作れず、呼び出し元が例外を unavailable に変換する口を既に持つため
  if (found.rootUnreadable !== undefined) {
    throw new Error(
      `未 push の観測の探索起点（job.cwd）を読めなかった: ${cwd} — ${found.rootUnreadable}`,
    );
  }
  const timeoutMs = options.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const worktrees: UnpushedWorkTree[] = [];
  let stoppedEarly = false;
  for (const repoRoot of found.paths) {
    const relative = describeWorktreePath(cwd, repoRoot);
    if (options.signal?.aborted === true) {
      stoppedEarly = true;
      const reason =
        '確かめられなかった（呼び出し元の期限切れで、この作業ツリーへ進む前に打ち切った）';
      worktrees.push({
        relativePath: relative,
        branch: null,
        unpushedCommitCountUnknown: reason,
        uncommittedChangeCountUnknown: reason,
      });
      continue;
    }
    const [branch, unpushed, uncommitted, remoteOrigin] = await Promise.all([
      probeBranch(options.spawn, repoRoot, options.env, timeoutMs),
      probeUnpushedCommitCount(options.spawn, repoRoot, options.env, timeoutMs),
      probeUncommittedChangeCount(options.spawn, repoRoot, options.env, timeoutMs),
      probeRemoteOrigin(options.spawn, repoRoot, options.env, timeoutMs),
    ]);
    worktrees.push({
      relativePath: relative,
      branch,
      ...unpushed,
      ...uncommitted,
      ...(remoteOrigin === undefined ? {} : { remoteOrigin }),
    });
  }
  return {
    cwd,
    worktrees,
    ...(found.truncatedAtCount === undefined ? {} : { truncatedAtCount: found.truncatedAtCount }),
    ...(stoppedEarly ? { stoppedEarly: true } : {}),
    ...(found.unreadableDirCount === undefined
      ? {}
      : {
          unreadableDirCount: found.unreadableDirCount,
          ...(found.unreadableDirSample === undefined
            ? {}
            : { unreadableDirSample: found.unreadableDirSample }),
        }),
    ...(scratchRoots.unknownReason === undefined
      ? {}
      : { scratchRootsUnknown: scratchRoots.unknownReason }),
  };
}

export async function listWorktreeRoots(
  cwd: string,
  options: {
    managerId: string;
    tmpRootDir?: string;
    maxWorktrees?: number;
    readdirFn?: ReaddirFn;
  },
): Promise<{
  worktrees: { repoRoot: string; relativePath: string }[];
  truncatedAtCount?: number;
  unreadable?: string;
}> {
  const scratchRoots = await findManagerScratchRoots(
    options.tmpRootDir ?? MANAGER_SCRATCH_TMP_ROOT,
    options.managerId,
  );
  const found = await findGitDirsAcrossRoots([cwd, ...scratchRoots.paths], {
    maxCount: options.maxWorktrees,
    readdirFn: options.readdirFn,
  });
  if (found.rootUnreadable !== undefined) {
    return { worktrees: [], unreadable: found.rootUnreadable };
  }
  return {
    worktrees: found.paths.map((repoRoot) => ({
      repoRoot,
      relativePath: describeWorktreePath(cwd, repoRoot),
    })),
    ...(found.truncatedAtCount === undefined ? {} : { truncatedAtCount: found.truncatedAtCount }),
  };
}
