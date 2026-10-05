import { createHash, randomBytes } from 'node:crypto';
import { copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import { reasonOf } from './dropped-record.js';
import { redactSecretsInBody } from './redact.js';
import type { RescueWorktree } from './schema.js';
import { listWorktreeRoots, type ProcessSpawnFn } from './unpushed-work.js';

/**
 * 走行中に定期的に、**作業ツリーを動かさずに**退避用の ref を push する（Issue #1266）。
 *
 * ## なぜ
 *
 * runner の器が入れ替わると、委譲の未 push の作業ツリーが消える（2026-10-04 に2回）。
 * `closed` / `shutdown_unpushed_work` は「何が失われるか」を言うだけで、失われるものを
 * 守らない。ここは**守る側**——走行中に、前回から変わったぶんだけを remote の
 * `refs/alteroid-rescue/<委譲id>/<作業ツリーの短い名>` へ force push する。
 *
 * ## 決まっていること（オーナー決定 2026-10-05。動かさない）
 *
 * 1. **中身は追跡済みの変更まで。** 未 push のコミット（HEAD）と、追跡済みファイルの
 *    未コミットの変更（`git add -u` 相当）だけを commit にして送る。**未追跡のファイルは
 *    送らない**。件数と上限つきのパス（名前だけ・中身は出さない）を、台帳に「退避されなかった
 *    もの」として残す。repo が public なので、未追跡の自動送信と可視性での出し分けはしない。
 * 2. **名前空間は `refs/alteroid-rescue/`**（`refs/heads/` ではない）。毎回新しい commit
 *    なので `+<sha>:<ref>` の force 更新。
 * 3. **送る前の歯。** 退避 commit の差分（HEAD に対する差分と、origin に無い未 push
 *    コミットの差分）の**追加行**を、リポジトリに既にある伏せ字の判定
 *    （`redactSecretsInBody`。環境変数の値・既知のトークンの形・代入）に通す。変わるものが
 *    あれば**その回は送らない**。当たったファイルの名前までは台帳に残すが、文字列そのものは
 *    残さない。差分が上限を超えたら判定を打ち切って**送らない側**に倒す。
 *
 * ## 作業ツリーを動かさない作り方
 *
 * 実 index のコピー（無ければ `read-tree HEAD`）を `<gitdir>/alteroid-rescue.index.*` に
 * 作り、`GIT_INDEX_FILE` をそれに向けて `git add -u` → `git write-tree` → `git commit-tree
 * [-p HEAD]`。実 index・HEAD・reflog・作業ツリーを動かさず、`.git/index.lock` を握らない
 * （別プロセスの add / commit と並走しても衝突しない）。`git stash create` は実 index を
 * 書き換えるので使わない。**実 index のコピーを土台にする**のは、`git add` 済みで未コミットの
 * 新規ファイル（追跡済み）と、HEAD が無い（unborn）作業ツリーを取りこぼさないため。
 * push は `git -c core.hooksPath=/dev/null push`（hook を走らせない）、
 * `GIT_TERMINAL_PROMPT=0` / `GIT_OPTIONAL_LOCKS=0`。
 *
 * ## 出さないもの
 *
 * git の stderr の文面は台帳へ運ばない（パスや URL の断片が混ざりうる）。失敗は分類
 * （`auth` / `network` / `rejected` / `timeout` / `other`）だけ。submodule の中の変更は
 * 退避されない（件数だけ台帳に出す）。
 */

/** 退避 ref の名前空間。 */
export const RESCUE_REF_PREFIX = 'refs/alteroid-rescue/';

/** 周期の環境変数。単位は ms。 */
export const RESCUE_INTERVAL_MS_ENV_KEY = 'ALTEROID_RESCUE_INTERVAL_MS';

/**
 * 既定の周期（5分）。**能力の上限ではなく、混雑を作らないための間隔**である
 * （north_star 禁止2。回数は制限していない）。前回と同じ tree・HEAD なら git の
 * push は撃たない。
 */
export const DEFAULT_RESCUE_INTERVAL_MS = 5 * 60_000;

/**
 * 周期を環境から読む。**未設定・空・数値でない・0 以下は既定へ倒す**
 * （`resolveSynthesizedNoticeWindowMs` と同じ作法。ただし値が読めなくても
 * 退避を止めない）。
 */
export function resolveRescueIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RESCUE_INTERVAL_MS_ENV_KEY]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RESCUE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESCUE_INTERVAL_MS;
  return parsed;
}

/** 未追跡のパスを台帳へ載せる上限。溢れたら件数だけ（`omitted`）。 */
export const RESCUE_UNTRACKED_PATHS_LIMIT = 20;
/** 1本のパスを台帳へ載せる長さの上限。 */
const PATH_NAME_MAX_LENGTH = 200;
/** 鍵らしい文字列に当たったファイル名を台帳へ載せる上限。 */
const SECRET_FILES_LIMIT = 5;
/** 判定する差分の大きさの上限（バイト。1本あたり）。超えたら送らない側に倒す。 */
export const RESCUE_DIFF_MAX_BYTES = 2 * 1024 * 1024;
/** 一覧系の git の出力の上限（バイト）。 */
const LIST_MAX_BYTES = 4 * 1024 * 1024;
/** git 1本あたりの期限（push 以外）。 */
const GIT_TIMEOUT_MS = 20_000;
/** push の期限。 */
const PUSH_TIMEOUT_MS = 90_000;

/** 空 tree の sha（SHA-1 の repo）。unborn の HEAD に対する差分の土台。 */
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** `maxBytes` を超えたので打ち切った。 */
  readonly overflow: boolean;
}

interface GitCall {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

async function git(spawn: ProcessSpawnFn, args: string[], call: GitCall): Promise<GitResult> {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (call.signal?.aborted === true) controller.abort();
  call.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, call.timeoutMs ?? GIT_TIMEOUT_MS);
  timer.unref?.();
  const maxBytes = call.maxBytes ?? LIST_MAX_BYTES;
  try {
    const child = spawn({
      command: 'git',
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
    let overflow = false;
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
      // 分類にしか使わない。長く持たない。
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    return { stdout, stderr, exitCode, timedOut, overflow };
  } catch {
    return { stdout: '', stderr: '', exitCode: null, timedOut, overflow: false };
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onCallerAbort);
  }
}

function ok(result: GitResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.overflow;
}

type PushFailureKind = 'auth' | 'network' | 'rejected' | 'timeout' | 'other';

/** push の失敗を分類する。**git の文面そのものは返さない。** */
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

/**
 * 退避 ref の名前。`refs/alteroid-rescue/<委譲id>/<相対パスの名前>-<絶対パスの sha1 の頭8字>`。
 * 相対パスの名前だけでは `cwd` の外（絶対パス）の作業ツリーや、同じ名前の別ツリーと
 * ぶつかるので、絶対パスのハッシュを足して**作業ツリーを一意にする**。
 */
export function rescueRefName(managerId: string, repoRoot: string, relativePath: string): string {
  const base = relativePath === '.' ? 'root' : sanitizeRefComponent(relativePath, 40);
  const hash = createHash('sha1').update(path.resolve(repoRoot)).digest('hex').slice(0, 8);
  const id = sanitizeRefComponent(managerId, 80) || 'unknown';
  return `${RESCUE_REF_PREFIX}${id}/${base === '' ? 'tree' : base}-${hash}`;
}

/**
 * 差分（`git diff` / `git log -p` の出力）の**追加行**を、ファイルごとに伏せ字の判定へ通し、
 * 変わった（＝鍵らしい文字列を含む）ファイルの名前を返す。**文字列そのものは返さない。**
 * 削除行は見ない（push 済みの内容を消す差分で止めない）。
 */
export function filesWithSecretLikeAdditions(
  diffText: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  const hits: string[] = [];
  let currentFile = '(不明)';
  let added: string[] = [];
  const flush = (): void => {
    if (added.length === 0) return;
    const body = added.join('\n');
    if (redactSecretsInBody(body, env) !== body && !hits.includes(currentFile)) {
      hits.push(currentFile);
    }
    added = [];
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const idx = line.lastIndexOf(' b/');
      currentFile = idx === -1 ? '(不明)' : line.slice(idx + 3);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  flush();
  return hits;
}

/** 1つの作業ツリーについて、前回までに覚えておくもの。 */
interface RescueEntry {
  /** 結果が確定した（再試行しない）ときの `HEAD:tree`。 */
  definitiveKey?: string;
  definitiveNotPushed?: RescueWorktree['notPushed'];
  pushed?: NonNullable<RescueWorktree['pushed']>;
  /** 前回台帳へ運んだ中身の署名（`at` を除く）。同じなら送らない。 */
  signature?: string;
}

/** セッション1本ぶんの退避の記憶。作業ツリー（絶対パス）ごと。 */
export class RescueMemory {
  readonly #entries = new Map<string, RescueEntry>();
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
  /** 子（git）の env。`GH_TOKEN` はここに在る。 */
  readonly env: Record<string, string | undefined>;
  readonly memory: RescueMemory;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** テスト用。省略は `GH_TOKEN` / `GITHUB_TOKEN` が在るか。 */
  readonly hasCredential?: (env: Record<string, string | undefined>) => boolean;
  readonly tmpRootDir?: string;
  readonly diffMaxBytes?: number;
}

function defaultHasCredential(env: Record<string, string | undefined>): boolean {
  return [env.GH_TOKEN, env.GITHUB_TOKEN].some((v) => v !== undefined && v.trim() !== '');
}

function clipPath(name: string): string {
  return name.length > PATH_NAME_MAX_LENGTH ? `${name.slice(0, PATH_NAME_MAX_LENGTH)}…` : name;
}

/**
 * `cwd`（と委譲 id のスクラッチ）の作業ツリーそれぞれを1回ずつ退避し、**台帳へ運ぶべき
 * 変化があった作業ツリーの分だけ**を返す。投げない。
 */
export async function runRescue(cwd: string, options: RunRescueOptions): Promise<RescueWorktree[]> {
  const listed = await listWorktreeRoots(cwd, {
    managerId: options.managerId,
    ...(options.tmpRootDir === undefined ? {} : { tmpRootDir: options.tmpRootDir }),
  });
  const reports: RescueWorktree[] = [];
  for (const tree of listed.worktrees) {
    if (options.signal?.aborted === true) break;
    try {
      const report = await rescueOne(tree.repoRoot, tree.relativePath, options);
      if (report !== undefined) reports.push(report);
    } catch (error) {
      // 1本の失敗で他の作業ツリーを止めない。文面は運ばず分類だけ。
      void reasonOf(error);
      const entry = options.memory.entry(tree.repoRoot);
      const report: RescueWorktree = {
        relativePath: tree.relativePath,
        branch: null,
        at: (options.now?.() ?? new Date()).toISOString(),
        ...(entry.pushed === undefined ? {} : { pushed: entry.pushed }),
        notPushed: { reason: 'error' },
      };
      const signature = JSON.stringify({ ...report, at: undefined });
      if (entry.signature !== signature) {
        entry.signature = signature;
        reports.push(report);
      }
    }
  }
  return reports;
}

async function rescueOne(
  repoRoot: string,
  relativePath: string,
  options: RunRescueOptions,
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
  const emitIfChanged = (report: RescueWorktree): RescueWorktree | undefined => {
    const signature = JSON.stringify({ ...report, at: undefined });
    if (entry.signature === signature) return undefined;
    entry.signature = signature;
    return report;
  };
  if (!ok(gitDirResult) || gitDir === '')
    return emitIfChanged(finish({ branch: null, notPushed: { reason: 'error' } }));

  const headResult = await git(spawn, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], base);
  const head = ok(headResult) ? headResult.stdout.trim() : undefined;
  const branchResult = await git(spawn, ['symbolic-ref', '-q', '--short', 'HEAD'], base);
  const branch =
    ok(branchResult) && branchResult.stdout.trim() !== '' ? branchResult.stdout.trim() : null;

  // 一時 index。実 index のコピーを土台にする（unborn・追跡済みの新規ファイルを落とさない）。
  const indexFile = path.join(gitDir, `alteroid-rescue.index.${randomBytes(6).toString('hex')}`);
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
    let seeded = false;
    try {
      await copyFile(path.join(gitDir, 'index'), indexFile);
      seeded = true;
    } catch {
      seeded = false;
    }
    if (!seeded) {
      const read = await git(
        spawn,
        head === undefined ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'],
        idxCall,
      );
      if (!ok(read)) return emitIfChanged(finish({ branch, notPushed: { reason: 'error' } }));
    }
    const added = await git(spawn, ['add', '-u'], idxCall);
    if (!ok(added)) return emitIfChanged(finish({ branch, notPushed: { reason: 'error' } }));
    const written = await git(spawn, ['write-tree'], idxCall);
    const tree = written.stdout.trim();
    if (!ok(written) || tree === '') {
      return emitIfChanged(finish({ branch, notPushed: { reason: 'error' } }));
    }

    // 退避されなかったもの（名前だけ）。
    const untrackedResult = await git(
      spawn,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      base,
    );
    let untracked: RescueWorktree['untracked'];
    if (ok(untrackedResult)) {
      const names = untrackedResult.stdout.split('\0').filter((n) => n !== '');
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

    const key = `${head ?? 'unborn'}:${tree}`;
    if (entry.definitiveKey === key) return emitIfChanged(withExtras(entry.definitiveNotPushed));

    const settle = (notPushed: RescueWorktree['notPushed'], definitive: boolean) => {
      if (definitive) {
        entry.definitiveKey = key;
        entry.definitiveNotPushed = notPushed;
      } else {
        delete entry.definitiveKey;
        delete entry.definitiveNotPushed;
      }
      return emitIfChanged(withExtras(notPushed));
    };

    // 送るものが有るか。
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

    // 送る前の歯。
    const maxBytes = options.diffMaxBytes ?? RESCUE_DIFF_MAX_BYTES;
    const diffArgs = ['--no-color', '--no-ext-diff', '--no-textconv'];
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
            ['log', '-p', ...diffArgs, '--format=', 'HEAD', '--not', '--remotes=origin'],
            { ...base, maxBytes },
          );
    if (treeDiff.overflow || logDiff?.overflow === true) {
      return settle({ reason: 'too-large' }, true);
    }
    if (!ok(treeDiff) || (logDiff !== undefined && !ok(logDiff))) {
      // 判定できなかった。送らない側に倒す。
      return settle({ reason: 'error' }, false);
    }
    const hitFiles = [
      ...new Set([
        ...filesWithSecretLikeAdditions(treeDiff.stdout, env),
        ...(logDiff === undefined ? [] : filesWithSecretLikeAdditions(logDiff.stdout, env)),
      ]),
    ];
    if (hitFiles.length > 0) {
      return settle(
        {
          reason: 'secret-like',
          files: hitFiles
            .slice(0, SECRET_FILES_LIMIT)
            .map((f) => clipPath(redactSecretsInBody(f, env))),
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
    if (!ok(committed) || commit === '') return settle({ reason: 'error' }, false);

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
    entry.pushed = { ref, commit, at };
    return settle(undefined, true);
  } finally {
    await unlink(indexFile).catch(() => undefined);
    await unlink(`${indexFile}.lock`).catch(() => undefined);
  }
}
