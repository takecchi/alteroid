import { createHash, randomBytes } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
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
 * 実 index のコピー（git と同じ子ユーザーの `cp -p`。無ければ `read-tree HEAD`）を
 * `<gitdir>/alteroid-rescue.index.*` に作り（SIGKILL で残ったものは次の回が掃除する）、
 * `git add -N` の項目は一時 index から外して未追跡として数え、`GIT_INDEX_FILE` をそれに向けて `git add -u` → `git write-tree` → `git commit-tree
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

/** 周期の下限（ms）。混雑を作らないための下限であって、回数の制限ではない。 */
export const MIN_RESCUE_INTERVAL_MS = 1000;
/**
 * 周期の上限（ms）。**運用の上限ではなく、タイマーの仕様の範囲を守るためのもの**——
 * `setInterval` は 2^31-1 ms を超える値を 1ms 周期へ倒す。
 */
export const MAX_RESCUE_INTERVAL_MS = 2_147_483_647;

/**
 * 周期を環境から読む。**未設定・空・数値でない・0 以下は既定へ倒す**
 * （`resolveSynthesizedNoticeWindowMs` と同じ作法。ただし値が読めなくても
 * 退避を止めない）。読めた値は {@link MIN_RESCUE_INTERVAL_MS}〜
 * {@link MAX_RESCUE_INTERVAL_MS} に挟む。
 */
export function resolveRescueIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RESCUE_INTERVAL_MS_ENV_KEY]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RESCUE_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESCUE_INTERVAL_MS;
  return Math.min(MAX_RESCUE_INTERVAL_MS, Math.max(MIN_RESCUE_INTERVAL_MS, parsed));
}

/**
 * いまこのプロセスで使っている一時 index（絶対パス）。**掃除は mtime で判定しない**——
 * `cp -p` は mtime を元の index に揃えるので、実 index が長く書かれていなければ生きている
 * 複製も「古い」。同じ cwd を複数のセッションが共有しうる（タイマーは全セッションを撃つ）ので、
 * 別の回の掃除が複製を消すと、`GIT_INDEX_FILE=<消えたファイル> git add -u` は 0 終了のまま
 * 空 tree を作り、前回の正しい退避 ref を空 commit で force 上書きしてしまう。
 */
const liveIndexFiles = new Set<string>();

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM は「在るが権限が無い」＝生きている。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGKILL で残った一時 index（`<gitdir>/alteroid-rescue.index.<pid>.<乱数>`）を消す。
 * 消さないもの: このプロセスの生きている回（{@link liveIndexFiles}）と、pid が生きている
 * 他プロセスのもの。pid の読めない旧形式の名前だけは {@link STALE_INDEX_AGE_MS} より古ければ消す。
 */
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
  /** 既定は `git`。一時 index の複製（`cp`）だけが別のコマンドを使う。 */
  readonly command?: string;
}

async function git(spawn: ProcessSpawnFn, args: string[], call: GitCall): Promise<GitResult> {
  const controller = new AbortController();
  let timedOut = false;
  // 呼び出し元の期限切れ（畳む直前の abort など）も「期限」として分類する。
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
      // 分類にしか使わない。長く持たない。
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
  // `diff --git` から最初の `@@` までがヘッダ。ヘッダの `+++ b/x` は追加行ではないが、
  // `@@` 以降の `+` で始まる行は（内容が `++ …` で `+++` に見えるものも含め）全部が追加行。
  let inHeader = false;
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
      inHeader = true;
      const idx = line.lastIndexOf(' b/');
      currentFile = idx === -1 ? '(不明)' : line.slice(idx + 3);
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) inHeader = false;
      continue;
    }
    if (line.startsWith('+')) added.push(line.slice(1));
  }
  flush();
  return hits;
}

/** 変わらない結果を台帳へ運び直す間隔（30分）。 */
export const RESCUE_RESEND_AFTER_MS = 30 * 60_000;
/** 一時 index の残骸（SIGKILL で残ったもの）を掃除する年齢。 */
const STALE_INDEX_AGE_MS = 10 * 60_000;

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
  readonly #nowMs: () => number;
  #lastResendMs: number;
  constructor(nowMs: () => number = Date.now) {
    this.#nowMs = nowMs;
    this.#lastResendMs = nowMs();
  }
  /**
   * **運べたかどうかを確かめる手段が無い**（`emit` は送りっぱなしで、台帳へ届いたかの
   * 返事が無い）ので、変わらない作業ツリーも {@link RESCUE_RESEND_AFTER_MS} ごとに
   * 1回は台帳へ運び直す（台帳側の merge は冪等）。届かなかった回の損失は、最大でこの間隔
   * に収まる。毎周期は運ばない（同じ結果の繰り返しで台帳を書き続けないため）。
   */
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
  const resend = options.memory.takeResend();
  for (const tree of listed.worktrees) {
    if (options.signal?.aborted === true) break;
    try {
      const report = await rescueOne(tree.repoRoot, tree.relativePath, options, resend);
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

/** 「入った」を探す、origin の remote-tracking の直近の commit の数。 */
export const RESCUE_LANDED_SCAN_COMMITS = 300;

/** この tree が、origin の remote-tracking の直近の commit のどれかの tree と同じか。 */
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
  // 読めなかったら「入っていない」（消さない側）。
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

  // 一時 index。実 index のコピーを土台にする（unborn・追跡済みの新規ファイルを落とさない）。
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
    // **複製は git と同じ子ユーザーの `cp -p` で行う**（runner 本体の fs ではなく）。実 index が
    // 0600 でも子が読め、複製の所有者も子になる。`-p` は mtime を元の index に揃える
    // （**racy git。実測で踏んだ**: 複製の mtime が「いま」になると、直前に同じ大きさへ
    // 書き換えたファイルを git が「変わっていない」と読み、変更を取りこぼす）。
    const copied = await git(spawn, ['-p', path.join(gitDir, 'index'), indexFile], {
      ...base,
      command: 'cp',
    });
    // `cp` が失敗して `read-tree HEAD` に倒れた回は、`git add` 済みで未コミットの新規ファイル
    // （追跡済み）を取りこぼす（HEAD に無いため）。台帳には出さない既知の取りこぼし。
    const seeded = ok(copied);
    if (!seeded) {
      const read = await git(
        spawn,
        head === undefined ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'],
        idxCall,
      );
      if (!ok(read)) return emitIfChanged(finish({ branch, notPushed: failure() }));
    }
    // **intent-to-add（`git add -N`）の項目は未追跡として扱う。** 実 index を土台にすると
    // i-t-a の項目が `add -u` で中身ごと tree に入る。一時 index から外し、名前を
    // 「退避されなかったもの」へ足す（`ls-files --others` には出ない）。
    const itaResult = await git(
      spawn,
      ['diff-files', '--diff-filter=A', '--name-only', '-z'],
      idxCall,
    );
    // i-t-a を検出できなかったら、外さずに送る側へ倒れず送らない。
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
    // 一時 index が消えていたら（別の回の掃除など）、`add -u` / `write-tree` は 0 終了のまま
    // 空 tree を作る。読めないなら失敗（送らない）。
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

    // 退避されなかったもの（名前だけ）。
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

    // 送った退避の中身が、もう origin の枝に入ったか。ネットワークは使わない（ローカルの
    // remote-tracking の直近の commit の tree と比べる）。入っていれば後始末が即座に消せる。
    // 退避の結果（`definitiveKey`）が変わらないあいだも、push や fetch で remote-tracking が
    // 進むので、`landedAt` が付くまでは毎回見る（git log 1本）。
    if (entry.pushed?.tree !== undefined && entry.pushed.landedAt === undefined) {
      if (await treeIsInOrigin(spawn, base, entry.pushed.tree)) {
        entry.pushed = { ...entry.pushed, landedAt: at };
      }
    }

    const key = `${head ?? 'unborn'}:${tree}`;
    if (entry.definitiveKey === key) return emitIfChanged(withExtras(entry.definitiveNotPushed));

    const settle = (notPushed: RescueWorktree['notPushed'], definitive: boolean) => {
      // 呼び出し元の期限が切れていたら、途中の git の失敗や取りこぼしを根拠にした結論
      // （送るものが無い・origin が無い 等）は信用しない。timeout として確定させない。
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
    // 保険: 退避の tree が空で HEAD の tree が空でないなら、全部消えた（一時 index の欠落など）
    // と見て送らない（前回の正しい退避 ref を空 commit で上書きしない）。
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

    // 送る前の歯。
    const maxBytes = options.diffMaxBytes ?? RESCUE_DIFF_MAX_BYTES;
    // `--text`: バイナリ扱い（NUL・`-diff` 属性）のファイルも中身を差分に出して判定する。
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
      // 判定できなかった。送らない側に倒す。
      return settle(failure(), false);
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

// ---------------------------------------------------------------------------
// 後始末（Issue #1266。docs/architecture.md「退避 ref」）
// ---------------------------------------------------------------------------

/**
 * remote の URL から**資格を落とした**文字列を作る（台帳の `pushed.remote`）。
 *
 * - `scheme://[userinfo@]host/path` は userinfo・クエリ・フラグメントを落として組み直す。
 * - scp 形式（`git@host:owner/repo.git`）は、ユーザー名が `git` のときだけ残す（それ以外は
 *   資格の断片でありうるので `host:path` に落とす）。
 * - ローカルのパス（`/…`）はそのまま（資格を持たない。主にテストの bare リポジトリ）。
 * - 解釈できない形は `undefined`（台帳に所在を残さない＝後始末は `no-remote` で消さない）。
 */
export function redactRemoteUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 2048 || /[\s\u0000-\u001f]/.test(trimmed))
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
    if (url.hostname === '') return undefined;
    const port = url.port === '' ? '' : `:${url.port}`;
    return `${url.protocol}//${url.hostname}${port}${url.pathname}`;
  }
  if (trimmed.startsWith('/')) return trimmed;
  const scp = /^(?:([^@\s/]+)@)?([^@:\s/]+):(.+)$/.exec(trimmed);
  if (scp !== null) {
    const rest = (scp[3] ?? '').split(/[?#]/)[0] ?? '';
    if (rest === '') return undefined;
    return `${scp[1] === 'git' ? 'git@' : ''}${scp[2] ?? ''}:${rest}`;
  }
  return undefined;
}

/** 後始末が消してよい ref の形。**退避の名前空間の中の2階層だけ**（他の ref を消す口にしない）。 */
const RESCUE_REF_PATTERN = /^refs\/alteroid-rescue\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

/** 台帳の `pushed.commit` として受ける形。 */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** 後始末の push の期限。 */
const DELETE_TIMEOUT_MS = 60_000;

export type RescueRefDeleteResult =
  | { readonly outcome: 'removed'; readonly alreadyGone: boolean }
  | {
      readonly outcome: 'failed';
      readonly kind: 'auth' | 'network' | 'timeout' | 'moved' | 'no-remote' | 'other';
    };

export interface DeleteRescueRefOptions {
  readonly spawn: ProcessSpawnFn;
  /** 子（git）の env。`GH_TOKEN` はここに在る。 */
  readonly env: Record<string, string | undefined>;
  readonly remote: string;
  readonly ref: string;
  /** 台帳が覚えている退避 commit。**remote の ref がこれと違えば消さない**（lease）。 */
  readonly commit: string;
  readonly signal?: AbortSignal;
  readonly tmpRootDir?: string;
  readonly hasCredential?: (env: Record<string, string | undefined>) => boolean;
}

/**
 * 退避 ref を remote から消す。**作業ツリーも委譲のセッションも要らない**（委譲が終わると
 * どちらも無いことがある）——ここが撃つのは `git push <url> --delete` で、git が
 * リポジトリを要求するので、子ユーザーが作る空の bare を一時的に `--git-dir` に使う。
 *
 * - **lease**: `--force-with-lease=<ref>:<commit>`。台帳より新しい退避が remote に在れば
 *   消さない（`moved`）。「判定できない」を「消してよい」へ倒さない。
 * - 消そうとしたら既に無かった（lease が stale を返し、`ls-remote` が空）なら `removed`
 *   （`alreadyGone`）。
 * - hook 無効・`GIT_TERMINAL_PROMPT=0`・期限付き。投げない。
 * - 消してよい ref の形は {@link RESCUE_REF_PATTERN} だけ。**呼び出し元が何を渡しても**
 *   退避の名前空間の外は消さない。
 */
export async function deleteRescueRef(
  options: DeleteRescueRefOptions,
): Promise<RescueRefDeleteResult> {
  const { spawn, env, remote, ref, commit } = options;
  if (!RESCUE_REF_PATTERN.test(ref) || !COMMIT_PATTERN.test(commit)) {
    return { outcome: 'failed', kind: 'other' };
  }
  // 台帳に載せた形（資格を落とした形）そのものだけを受ける。`ext::` 等の transport も弾く。
  if (redactRemoteUrl(remote) !== remote || remote.includes('::')) {
    return { outcome: 'failed', kind: 'no-remote' };
  }
  const hasCredential = options.hasCredential ?? defaultHasCredential;
  // ローカルのパスは資格が要らない。それ以外で資格が無ければ撃たない。
  if (!remote.startsWith('/') && !remote.startsWith('file://') && !hasCredential(env)) {
    return { outcome: 'failed', kind: 'auth' };
  }
  const tmpRoot = options.tmpRootDir ?? os.tmpdir();
  const scratch = path.join(
    tmpRoot,
    `alteroid-rescue-del.${String(process.pid)}.${randomBytes(6).toString('hex')}.git`,
  );
  if (!path.isAbsolute(scratch)) return { outcome: 'failed', kind: 'other' };
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
    // lease が外れた。無いのか（消えている）、別の commit に動いたのか。
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
    await git(spawn, ['-rf', scratch], { ...call, command: 'rm' }).catch(() => undefined);
  }
}
