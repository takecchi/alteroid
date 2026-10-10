import { createHash, randomBytes } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { reasonOf } from './dropped-record.js';
import { codePointBoundary } from './excerpt.js';
import { redactSecretsInBody, secretPatternsInBody, type SecretPatternName } from './redact.js';
import type { RescueWorktree } from './schema.js';
import { listWorktreeRoots, type ProcessSpawnFn } from './unpushed-work.js';

// 未追跡のファイルは送らない: repo が public で、未追跡の自動送信は可視性での出し分けもしない決定。
// 実 index のコピーを土台にする: `git add` 済みで未コミットの新規ファイルと unborn の HEAD を取りこぼさないため。
// `git stash create` は実 index を書き換えるので使わない。
// 送る前に追加行を伏せ字の判定に通し、変わるものがあればその回は送らない。差分が上限を超えたら送らない側に倒す。
// git の stderr の文面は台帳へ運ばない（パスや URL の断片が混ざりうる）。

export const RESCUE_REF_PREFIX = 'refs/alteroid-rescue/';

export const RESCUE_INTERVAL_MS_ENV_KEY = 'ALTEROID_RESCUE_INTERVAL_MS';

// 能力の上限ではなく、混雑を作らないための間隔（回数は制限していない）。
export const DEFAULT_RESCUE_INTERVAL_MS = 5 * 60_000;

// 混雑を作らないための下限であって、回数の制限ではない。
export const MIN_RESCUE_INTERVAL_MS = 1000;
/** `setInterval` は 2^31-1 ms を超える値を 1ms 周期へ倒すので、上限はそこで切る。 */
export const MAX_RESCUE_INTERVAL_MS = 2_147_483_647;

export function resolveRescueIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RESCUE_INTERVAL_MS_ENV_KEY]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RESCUE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESCUE_INTERVAL_MS;
  return Math.min(MAX_RESCUE_INTERVAL_MS, Math.max(MIN_RESCUE_INTERVAL_MS, parsed));
}

/**
 * 掃除は mtime で判定しない: `cp -p` は mtime を元の index に揃えるので生きている複製も「古い」。
 * 別の回の掃除が複製を消すと `git add -u` は 0 終了のまま空 tree を作り、前回の正しい退避 ref を上書きする。
 */
const liveIndexFiles = new Set<string>();

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM は在るが権限が無い＝生きている。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function removeStaleIndexFiles(gitDir: string): Promise<void> {
  try {
    for (const name of await readdir(gitDir)) {
      const match = /^alteroid-rescue\.index\.(?:(\d+)\.)?[0-9a-f]+$/.exec(name);
      if (match === null) continue;
      const file = path.join(gitDir, name);
      if (liveIndexFiles.has(file)) continue;
      const pid = match[1] === undefined ? undefined : Number(match[1]);
      if (pid !== undefined) {
        if (pid !== process.pid && pidIsAlive(pid)) continue;
      } else {
        const info = await stat(file).catch(() => undefined);
        if (info === undefined || Date.now() - info.mtimeMs <= STALE_INDEX_AGE_MS) continue;
      }
      await unlink(file).catch(() => undefined);
    }
  } catch {
    // 掃除は best-effort。
  }
}

async function indexIsReadable(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined)) !== undefined;
}

export const RESCUE_UNTRACKED_PATHS_LIMIT = 20;
const PATH_NAME_MAX_LENGTH = 200;
const SECRET_FILES_LIMIT = 5;
export const RESCUE_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 90_000;

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly overflow: boolean;
}

interface GitCall {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly command?: string;
}

async function git(spawn: ProcessSpawnFn, args: string[], call: GitCall): Promise<GitResult> {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => {
    timedOut = true;
    controller.abort();
  };
  if (call.signal?.aborted === true) onCallerAbort();
  call.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs ?? GIT_TIMEOUT_MS);
  timer.unref?.();
  const maxBytes = call.maxBytes ?? LIST_MAX_BYTES;
  let overflow = false;
  try {
    const child = spawn({
      command: call.command ?? 'git',
      args,
      cwd: call.cwd,
      env: {
        ...call.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
      signal: controller.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > maxBytes) {
        overflow = true;
        stdout = '';
        controller.abort();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    return { stdout, stderr, exitCode, timedOut, overflow };
  } catch {
    return { stdout: '', stderr: '', exitCode: null, timedOut, overflow };
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function ok(result: GitResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.overflow;
}

type PushFailureKind = 'auth' | 'network' | 'rejected' | 'timeout' | 'other';

export function classifyPushFailure(result: {
  stderr: string;
  timedOut: boolean;
}): PushFailureKind {
  if (result.timedOut) return 'timeout';
  const text = result.stderr;
  if (
    /Authentication failed|could not read (Username|Password)|Permission denied|\b40[13]\b|Invalid username|denied to|not authorized|Repository not found/i.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (/rejected|protected|pre-receive|hook declined|non-fast-forward/i.test(text)) {
    return 'rejected';
  }
  if (
    /Could not resolve host|Connection (timed out|refused|reset)|unable to access|Network is unreachable|early EOF|RPC failed/i.test(
      text,
    )
  ) {
    return 'network';
  }
  return 'other';
}

function sanitizeRefComponent(text: string, maxLength: number): string {
  const cleaned = text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, maxLength);
}

/** 相対パスの名前だけでは `cwd` の外の作業ツリーや同名の別ツリーとぶつかるので、絶対パスのハッシュを足す。 */
export function rescueRefName(managerId: string, repoRoot: string, relativePath: string): string {
  const base = relativePath === '.' ? 'root' : sanitizeRefComponent(relativePath, 40);
  const hash = createHash('sha1').update(path.resolve(repoRoot)).digest('hex').slice(0, 8);
  const id = sanitizeRefComponent(managerId, 80) || 'unknown';
  return `${RESCUE_REF_PREFIX}${id}/${base === '' ? 'tree' : base}-${hash}`;
}

export interface SecretLikeHit {
  readonly file: string;
  readonly patterns: readonly SecretPatternName[];
}

/**
 * 削除行は見ない: push 済みの内容を消す差分で止めない。文字列そのものは返さない。
 * NUL を含むファイルはバイナリとして、固有の接頭辞を持つ形と環境変数の鍵の値だけを見る。
 * 判定を git の属性に任せない: `-diff` を付けたテキストのファイルまで形の検査から外れるため。
 */
export function secretLikeAdditionsInDiff(
  diffText: string,
  env: NodeJS.ProcessEnv | undefined,
): SecretLikeHit[] {
  const hits = new Map<string, Set<SecretPatternName>>();
  let currentFile = '(不明)';
  // `@@` 以降の `+` で始まる行は、内容が `++ …` で `+++` に見えるものも含め全部が追加行。
  let inHeader = false;
  let added: string[] = [];
  let binary = false;
  const flush = (): void => {
    if (added.length > 0) {
      const patterns = secretPatternsInBody(added.join('\n'), env, { binary });
      if (patterns.length > 0) {
        const known = hits.get(currentFile) ?? new Set<SecretPatternName>();
        for (const name of patterns) known.add(name);
        hits.set(currentFile, known);
      }
    }
    added = [];
    binary = false;
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      inHeader = true;
      const idx = line.lastIndexOf(' b/');
      currentFile = idx === -1 ? '(不明)' : line.slice(idx + 3);
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) inHeader = false;
      continue;
    }
    // 文脈行・削除行の NUL も見る: 書き換えたバイナリの追加行だけには NUL が来ないことがあるため
    if (line.includes('\0')) binary = true;
    if (line.startsWith('+')) added.push(line.slice(1));
  }
  flush();
  return [...hits].map(([file, patterns]) => ({ file, patterns: [...patterns] }));
}

export const RESCUE_RESEND_AFTER_MS = 30 * 60_000;
const STALE_INDEX_AGE_MS = 10 * 60_000;

interface RescueEntry {
  definitiveKey?: string;
  definitiveNotPushed?: RescueWorktree['notPushed'];
  pushed?: NonNullable<RescueWorktree['pushed']>;
  signature?: string;
}

export class RescueMemory {
  readonly #entries = new Map<string, RescueEntry>();
  readonly #nowMs: () => number;
  #lastResendMs: number;
  constructor(nowMs: () => number = Date.now) {
    this.#nowMs = nowMs;
    this.#lastResendMs = nowMs();
  }
  /** `emit` は届いたかの返事が無いので、変わらないものも間隔ごとに運び直す。毎周期は運ばない（台帳を書き続けないため）。 */
  takeResend(): boolean {
    const now = this.#nowMs();
    if (now - this.#lastResendMs < RESCUE_RESEND_AFTER_MS) return false;
    this.#lastResendMs = now;
    return true;
  }
  entry(repoRoot: string): RescueEntry {
    let entry = this.#entries.get(repoRoot);
    if (entry === undefined) {
      entry = {};
      this.#entries.set(repoRoot, entry);
    }
    return entry;
  }
}

export interface RunRescueOptions {
  readonly managerId: string;
  readonly spawn: ProcessSpawnFn;
  readonly env: Record<string, string | undefined>;
  readonly memory: RescueMemory;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly hasCredential?: (env: Record<string, string | undefined>) => boolean;
  readonly tmpRootDir?: string;
  readonly diffMaxBytes?: number;
}

function defaultHasCredential(env: Record<string, string | undefined>): boolean {
  return [env.GH_TOKEN, env.GITHUB_TOKEN].some((v) => v !== undefined && v.trim() !== '');
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function clipPath(name: string): string {
  return name.length > PATH_NAME_MAX_LENGTH
    ? `${name.slice(0, codePointBoundary(name, PATH_NAME_MAX_LENGTH))}…`
    : name;
}

export async function runRescue(cwd: string, options: RunRescueOptions): Promise<RescueWorktree[]> {
  const listed = await listWorktreeRoots(cwd, {
    managerId: options.managerId,
    ...(options.tmpRootDir === undefined ? {} : { tmpRootDir: options.tmpRootDir }),
  });
  const reports: RescueWorktree[] = [];
  const resend = options.memory.takeResend();
  for (const tree of listed.worktrees) {
    if (options.signal?.aborted === true) break;
    try {
      const report = await rescueOne(tree.repoRoot, tree.relativePath, options, resend);
      if (report !== undefined) reports.push(report);
    } catch (error) {
      // 1本の失敗で他の作業ツリーを止めない。
      void reasonOf(error);
      const entry = options.memory.entry(tree.repoRoot);
      const report: RescueWorktree = {
        relativePath: tree.relativePath,
        branch: null,
        at: (options.now?.() ?? new Date()).toISOString(),
        ...(entry.pushed === undefined ? {} : { pushed: entry.pushed }),
        notPushed: { reason: isAborted(options.signal) ? 'timeout' : 'error' },
      };
      const signature = JSON.stringify({ ...report, at: undefined });
      if (resend || entry.signature !== signature) {
        entry.signature = signature;
        reports.push(report);
      }
    }
  }
  return reports;
}

export const RESCUE_LANDED_SCAN_COMMITS = 300;

async function treeIsInOrigin(
  spawn: ProcessSpawnFn,
  call: GitCall,
  tree: string,
): Promise<boolean> {
  const log = await git(
    spawn,
    ['log', `-n`, String(RESCUE_LANDED_SCAN_COMMITS), '--format=%T', '--remotes=origin'],
    call,
  );
  // 読めなかったら入っていない扱い（消さない側）。
  return ok(log) && log.stdout.split('\n').includes(tree);
}

async function rescueOne(
  repoRoot: string,
  relativePath: string,
  options: RunRescueOptions,
  resend: boolean,
): Promise<RescueWorktree | undefined> {
  const { spawn, env, signal } = options;
  const at = (options.now?.() ?? new Date()).toISOString();
  const entry = options.memory.entry(repoRoot);
  const base: GitCall = { cwd: repoRoot, env, ...(signal === undefined ? {} : { signal }) };

  const gitDirResult = await git(spawn, ['rev-parse', '--absolute-git-dir'], base);
  const gitDir = gitDirResult.stdout.trim();
  function finish(parts: {
    branch: string | null;
    notPushed?: RescueWorktree['notPushed'];
    untracked?: RescueWorktree['untracked'];
    submoduleCount?: number;
  }): RescueWorktree {
    return {
      relativePath,
      branch: parts.branch,
      at,
      ...(entry.pushed === undefined ? {} : { pushed: entry.pushed }),
      ...(parts.notPushed === undefined ? {} : { notPushed: parts.notPushed }),
      ...(parts.untracked === undefined ? {} : { untracked: parts.untracked }),
      ...(parts.submoduleCount === undefined ? {} : { submoduleCount: parts.submoduleCount }),
    };
  }
  const failure = (): NonNullable<RescueWorktree['notPushed']> => ({
    reason: signal?.aborted === true ? 'timeout' : 'error',
  });
  const emitIfChanged = (report: RescueWorktree): RescueWorktree | undefined => {
    const signature = JSON.stringify({ ...report, at: undefined });
    if (!resend && entry.signature === signature) return undefined;
    entry.signature = signature;
    return report;
  };
  if (!ok(gitDirResult) || gitDir === '')
    return emitIfChanged(finish({ branch: null, notPushed: failure() }));

  const headResult = await git(spawn, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], base);
  const head = ok(headResult) ? headResult.stdout.trim() : undefined;
  const branchResult = await git(spawn, ['symbolic-ref', '-q', '--short', 'HEAD'], base);
  const branch =
    ok(branchResult) && branchResult.stdout.trim() !== '' ? branchResult.stdout.trim() : null;

  const indexFile = path.join(
    gitDir,
    `alteroid-rescue.index.${String(process.pid)}.${randomBytes(6).toString('hex')}`,
  );
  liveIndexFiles.add(indexFile);
  const indexEnv: Record<string, string | undefined> = {
    ...env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? 'alteroid-rescue',
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? 'alteroid-rescue@localhost',
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME ?? 'alteroid-rescue',
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL ?? 'alteroid-rescue@localhost',
  };
  const idxCall: GitCall = { ...base, env: indexEnv };
  try {
    await removeStaleIndexFiles(gitDir);
    // 複製は runner 本体の fs ではなく git と同じ子ユーザーの `cp -p` で行う（実 index が 0600 でも読める）。
    // `-p` で mtime を揃える: 「いま」になると racy git で、同じ大きさへ書き換えた変更を git が取りこぼす。
    const copied = await git(spawn, ['-p', path.join(gitDir, 'index'), indexFile], {
      ...base,
      command: 'cp',
    });
    const seeded = ok(copied);
    if (!seeded) {
      const read = await git(
        spawn,
        head === undefined ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'],
        idxCall,
      );
      if (!ok(read)) return emitIfChanged(finish({ branch, notPushed: failure() }));
    }
    // intent-to-add（`git add -N`）の項目は一時 index から外して未追跡として数える: 残すと `add -u` で中身ごと tree に入る。
    const itaResult = await git(
      spawn,
      ['diff-files', '--diff-filter=A', '--name-only', '-z'],
      idxCall,
    );
    if (!ok(itaResult)) return emitIfChanged(finish({ branch, notPushed: failure() }));
    const itaNames = itaResult.stdout.split('\0').filter((n) => n !== '');
    for (let i = 0; i < itaNames.length; i += 100) {
      const removed = await git(
        spawn,
        ['update-index', '--force-remove', '--', ...itaNames.slice(i, i + 100)],
        idxCall,
      );
      if (!ok(removed)) return emitIfChanged(finish({ branch, notPushed: failure() }));
    }
    // 一時 index が消えていても `add -u` / `write-tree` は 0 終了のまま空 tree を作るので、読めなければ送らない。
    if (!(await indexIsReadable(indexFile))) {
      return emitIfChanged(finish({ branch, notPushed: failure() }));
    }
    const added = await git(spawn, ['add', '-u'], idxCall);
    if (!ok(added)) return emitIfChanged(finish({ branch, notPushed: failure() }));
    if (!(await indexIsReadable(indexFile))) {
      return emitIfChanged(finish({ branch, notPushed: failure() }));
    }
    const written = await git(spawn, ['write-tree'], idxCall);
    const tree = written.stdout.trim();
    if (!ok(written) || tree === '') {
      return emitIfChanged(finish({ branch, notPushed: failure() }));
    }

    const untrackedResult = await git(
      spawn,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      base,
    );
    let untracked: RescueWorktree['untracked'];
    {
      const names = [
        ...itaNames,
        ...(ok(untrackedResult) ? untrackedResult.stdout.split('\0').filter((n) => n !== '') : []),
      ];
      if (names.length > 0) {
        untracked = {
          count: names.length,
          paths: names.slice(0, RESCUE_UNTRACKED_PATHS_LIMIT).map(clipPath),
          omitted: Math.max(0, names.length - RESCUE_UNTRACKED_PATHS_LIMIT),
        };
      }
    }
    let submoduleCount: number | undefined;
    const stage = await git(spawn, ['ls-files', '--stage', '-z'], { ...base, env: indexEnv });
    if (ok(stage)) {
      const n = stage.stdout.split('\0').filter((l) => l.startsWith('160000 ')).length;
      if (n > 0) submoduleCount = n;
    }
    const withExtras = (notPushed: RescueWorktree['notPushed'] | undefined): RescueWorktree =>
      finish({
        branch,
        ...(notPushed === undefined ? {} : { notPushed }),
        ...(untracked === undefined ? {} : { untracked }),
        ...(submoduleCount === undefined ? {} : { submoduleCount }),
      });

    // `definitiveKey` が変わらないあいだも push や fetch で remote-tracking が進むので、`landedAt` が付くまでは毎回見る。
    if (entry.pushed?.tree !== undefined && entry.pushed.landedAt === undefined) {
      if (await treeIsInOrigin(spawn, base, entry.pushed.tree)) {
        entry.pushed = { ...entry.pushed, landedAt: at };
      }
    }

    const key = `${head ?? 'unborn'}:${tree}`;
    if (entry.definitiveKey === key) return emitIfChanged(withExtras(entry.definitiveNotPushed));

    const settle = (notPushed: RescueWorktree['notPushed'], definitive: boolean) => {
      // 期限が切れていたら、途中の git の失敗を根拠にした結論は信用せず timeout にする。
      if (
        signal?.aborted === true &&
        notPushed !== undefined &&
        notPushed.reason !== 'secret-like'
      ) {
        return emitIfChanged(withExtras({ reason: 'timeout' }));
      }
      if (definitive) {
        entry.definitiveKey = key;
        entry.definitiveNotPushed = notPushed;
      } else {
        delete entry.definitiveKey;
        delete entry.definitiveNotPushed;
      }
      return emitIfChanged(withExtras(notPushed));
    };

    let unpushedCount = 0;
    if (head !== undefined) {
      const counted = await git(
        spawn,
        ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
        base,
      );
      if (ok(counted)) unpushedCount = Number.parseInt(counted.stdout.trim(), 10) || 0;
      else unpushedCount = 1; // 数えられないなら送る側（失うよりよい）
    }
    const headTree =
      head === undefined
        ? EMPTY_TREE_SHA1
        : (await git(spawn, ['rev-parse', 'HEAD^{tree}'], base)).stdout.trim();
    // 退避の tree だけが空なら全部消えたと見て送らない（前回の正しい退避 ref を空 commit で上書きしない）。
    if (tree === EMPTY_TREE_SHA1 && headTree !== EMPTY_TREE_SHA1) {
      return settle(failure(), false);
    }
    if (tree === headTree && unpushedCount === 0) {
      return settle({ reason: 'nothing-tracked' }, true);
    }
    if (head === undefined && tree === EMPTY_TREE_SHA1) {
      return settle({ reason: 'nothing-tracked' }, true);
    }

    const hasCredential = options.hasCredential ?? defaultHasCredential;
    if (!hasCredential(env)) return settle({ reason: 'no-credential' }, false);
    const remote = await git(spawn, ['remote', 'get-url', 'origin'], base);
    if (!ok(remote)) return settle({ reason: 'no-remote' }, false);

    const maxBytes = options.diffMaxBytes ?? RESCUE_DIFF_MAX_BYTES;
    // `--text`: バイナリ扱いのファイルも中身を差分に出して判定する。
    const diffArgs = ['--no-color', '--no-ext-diff', '--no-textconv', '--text'];
    const treeDiff = await git(
      spawn,
      ['diff-tree', '-p', '-r', ...diffArgs, head === undefined ? EMPTY_TREE_SHA1 : head, tree],
      { ...base, maxBytes },
    );
    const logDiff =
      head === undefined || unpushedCount === 0
        ? undefined
        : await git(
            spawn,
            ['log', '-p', '-m', ...diffArgs, '--format=', 'HEAD', '--not', '--remotes=origin'],
            { ...base, maxBytes },
          );
    if (treeDiff.overflow || logDiff?.overflow === true) {
      return settle({ reason: 'too-large' }, true);
    }
    if (!ok(treeDiff) || (logDiff !== undefined && !ok(logDiff))) {
      return settle(failure(), false);
    }
    const hits = [
      ...secretLikeAdditionsInDiff(treeDiff.stdout, env),
      ...(logDiff === undefined ? [] : secretLikeAdditionsInDiff(logDiff.stdout, env)),
    ];
    if (hits.length > 0) {
      const hitFiles = [...new Set(hits.map((hit) => hit.file))];
      return settle(
        {
          reason: 'secret-like',
          files: hitFiles
            .slice(0, SECRET_FILES_LIMIT)
            .map((f) => clipPath(redactSecretsInBody(f, env))),
          // 規則の名前だけを残す: 誤判定かどうかを、文字列を見ずに後から辿れるようにするため
          patterns: [...new Set(hits.flatMap((hit) => hit.patterns))],
        },
        true,
      );
    }

    const commitArgs = [
      'commit-tree',
      tree,
      ...(head === undefined ? [] : ['-p', head]),
      '-m',
      `alteroid rescue: ${options.managerId}`,
    ];
    const committed = await git(spawn, commitArgs, idxCall);
    const commit = committed.stdout.trim();
    if (!ok(committed) || commit === '') return settle(failure(), false);

    const ref = rescueRefName(options.managerId, repoRoot, relativePath);
    const pushedResult = await git(
      spawn,
      [
        '-c',
        'core.hooksPath=/dev/null',
        'push',
        '--no-verify',
        '--no-recurse-submodules',
        'origin',
        `+${commit}:${ref}`,
      ],
      { ...base, timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (!ok(pushedResult)) {
      return settle(
        { reason: 'push-failed', failureKind: classifyPushFailure(pushedResult) },
        false,
      );
    }
    const remoteUrl = redactRemoteUrl(remote.stdout);
    entry.pushed = {
      ref,
      commit,
      at,
      tree,
      ...(remoteUrl === undefined ? {} : { remote: remoteUrl }),
    };
    return settle(undefined, true);
  } finally {
    liveIndexFiles.delete(indexFile);
    await unlink(indexFile).catch(() => undefined);
    await unlink(`${indexFile}.lock`).catch(() => undefined);
  }
}

/**
 * `https://` / `http://` は userinfo を全部落とす（ユーザー名に token が入る形がある）。`ssh://` と scp 形は
 * ssh の接続に要るのでユーザー名を残す。`-` で始まるホスト・ユーザー名は解釈しない（オプション注入）。
 * 解釈できない形は `undefined`（台帳に所在を残さず、後始末は消さない）。
 */
export function redactRemoteUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (
    trimmed === '' ||
    trimmed.length > 2048 ||
    /\s/.test(trimmed) ||
    [...trimmed].some((ch) => ch.charCodeAt(0) < 0x20)
  )
    return undefined;
  if (trimmed.startsWith('-')) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.protocol === 'file:') return `file://${url.pathname}`;
    if (url.hostname === '' || url.hostname.startsWith('-')) return undefined;
    const port = url.port === '' ? '' : `:${url.port}`;
    const user =
      url.protocol === 'ssh:' && url.username !== '' && !url.username.startsWith('-')
        ? `${decodeURIComponent(url.username)}@`
        : '';
    if (url.protocol === 'ssh:' && url.username.startsWith('-')) return undefined;
    return `${url.protocol}//${user}${url.hostname}${port}${url.pathname}`;
  }
  if (trimmed.startsWith('/')) return trimmed;
  const scp = /^(?:([^@\s/]+)@)?([^@:\s/]+):(.+)$/.exec(trimmed);
  if (scp !== null) {
    const user = scp[1];
    const host = scp[2] ?? '';
    if (host.startsWith('-') || user?.startsWith('-') === true) return undefined;
    const rest = (scp[3] ?? '').split(/[?#]/)[0] ?? '';
    if (rest === '') return undefined;
    return `${user === undefined ? '' : `${user}@`}${host}:${rest}`;
  }
  return undefined;
}

/** `https://`・`ssh://`・scp 形だけ撃つ: runner を任意の URL を撃つ口にしない。 */
export function isDeletableRemote(remote: string): boolean {
  if (redactRemoteUrl(remote) !== remote || remote.includes('::')) return false;
  const host = '[A-Za-z0-9][A-Za-z0-9.-]*';
  const user = '[A-Za-z0-9_][A-Za-z0-9._-]*';
  return (
    new RegExp(`^https://${host}(?::\\d+)?/[^\\s?#@]+$`).test(remote) ||
    new RegExp(`^ssh://(?:${user}@)?${host}(?::\\d+)?/[^\\s?#]+$`).test(remote) ||
    new RegExp(`^(?:${user}@)?${host}:(?!/?/)[^\\s?#:][^\\s?#]*$`).test(remote)
  );
}

// 退避の名前空間の中の2階層だけ消す: 他の ref を消す口にしない。
const RESCUE_REF_PATTERN = /^refs\/alteroid-rescue\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

// デーモンの HTTP 呼び出しの期限（60秒）の内側に、init + push + ls-remote を足しても収める。
const DELETE_TIMEOUT_MS = 20_000;

export type RescueRefDeleteResult =
  | { readonly outcome: 'removed'; readonly alreadyGone: boolean }
  | {
      readonly outcome: 'failed';
      readonly kind: 'auth' | 'network' | 'timeout' | 'moved' | 'no-remote' | 'other';
    };

export interface DeleteRescueRefOptions {
  readonly spawn: ProcessSpawnFn;
  readonly env: Record<string, string | undefined>;
  readonly remote: string;
  readonly ref: string;
  /** remote の ref がこれと違えば消さない（lease）。 */
  readonly commit: string;
  readonly signal?: AbortSignal;
  readonly tmpRootDir?: string;
  readonly hasCredential?: (env: Record<string, string | undefined>) => boolean;
  /** テスト専用。本番の口は `https://` / `ssh://` / scp 形だけ。 */
  readonly allowLocalRemote?: boolean;
}

/**
 * 作業ツリーも委譲のセッションも要らない（終わると無いことがある）。git がリポジトリを要求するので、
 * 空の bare を一時的に `--git-dir` に使う。lease で台帳より新しい退避は消さない（`moved`）。
 * 「判定できない」を「消してよい」へ倒さない。
 */
export async function deleteRescueRef(
  options: DeleteRescueRefOptions,
): Promise<RescueRefDeleteResult> {
  const { spawn, env, remote, ref, commit } = options;
  if (!RESCUE_REF_PATTERN.test(ref) || !COMMIT_PATTERN.test(commit)) {
    return { outcome: 'failed', kind: 'other' };
  }
  const local =
    options.allowLocalRemote === true &&
    remote.startsWith('/') &&
    redactRemoteUrl(remote) === remote;
  if (!local && !isDeletableRemote(remote)) return { outcome: 'failed', kind: 'no-remote' };
  const hasCredential = options.hasCredential ?? defaultHasCredential;
  if (!local && !hasCredential(env)) return { outcome: 'failed', kind: 'auth' };
  const tmpRoot = options.tmpRootDir ?? os.tmpdir();
  const scratch = path.join(
    tmpRoot,
    `alteroid-rescue-del.${String(process.pid)}.${randomBytes(6).toString('hex')}.git`,
  );
  if (!path.isAbsolute(scratch)) return { outcome: 'failed', kind: 'other' };
  await removeStaleScratch(spawn, env, tmpRoot);
  liveScratchDirs.add(scratch);
  const call: GitCall = {
    cwd: tmpRoot,
    env,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  try {
    const init = await git(spawn, ['init', '--bare', '--quiet', scratch], call);
    if (!ok(init)) return { outcome: 'failed', kind: init.timedOut ? 'timeout' : 'other' };
    const pushed = await git(
      spawn,
      [
        `--git-dir=${scratch}`,
        '-c',
        'core.hooksPath=/dev/null',
        'push',
        '--no-verify',
        '--no-recurse-submodules',
        `--force-with-lease=${ref}:${commit}`,
        remote,
        `:${ref}`,
      ],
      { ...call, timeoutMs: DELETE_TIMEOUT_MS },
    );
    if (ok(pushed)) return { outcome: 'removed', alreadyGone: false };
    const kind = classifyPushFailure(pushed);
    if (kind !== 'rejected') {
      return { outcome: 'failed', kind };
    }
    const listed = await git(spawn, ['ls-remote', remote, ref], {
      ...call,
      timeoutMs: DELETE_TIMEOUT_MS,
    });
    if (!ok(listed)) {
      return { outcome: 'failed', kind: listed.timedOut ? 'timeout' : 'other' };
    }
    if (listed.stdout.trim() === '') return { outcome: 'removed', alreadyGone: true };
    return { outcome: 'failed', kind: 'moved' };
  } finally {
    liveScratchDirs.delete(scratch);
    // 呼び出し元の signal を引き継がない: abort された回でもここが殺されると一時 bare が溜まる。
    await git(spawn, ['-rf', scratch], {
      cwd: tmpRoot,
      env,
      command: 'rm',
      timeoutMs: SCRATCH_RM_TIMEOUT_MS,
    }).catch(() => undefined);
  }
}

const SCRATCH_NAME = /^alteroid-rescue-del\.(\d+)\.[0-9a-f]+\.git$/;
const SCRATCH_RM_TIMEOUT_MS = 10_000;
const liveScratchDirs = new Set<string>();

async function removeStaleScratch(
  spawn: ProcessSpawnFn,
  env: Record<string, string | undefined>,
  tmpRoot: string,
): Promise<void> {
  try {
    for (const name of await readdir(tmpRoot)) {
      const match = SCRATCH_NAME.exec(name);
      if (match === null) continue;
      const dir = path.join(tmpRoot, name);
      if (liveScratchDirs.has(dir)) continue;
      const pid = Number(match[1]);
      if (pid !== process.pid && pidIsAlive(pid)) continue;
      await git(spawn, ['-rf', dir], {
        cwd: tmpRoot,
        env,
        command: 'rm',
        timeoutMs: SCRATCH_RM_TIMEOUT_MS,
      });
    }
  } catch {
    // 掃除は best-effort。
  }
}
