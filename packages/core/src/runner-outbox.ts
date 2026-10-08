import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  readdirSync,
  rmdirSync,
  chmodSync,
  chownSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { lstat, open, readdir, rm, stat, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

import type { AttachmentLimits } from './attachment.js';
import { isSafeRunnerSegment, RUNNER_ATTACHMENT_STALE_MS } from './runner-attachments.js';
import type { RunnerOutboxFile, RunnerOutboxRejectedFile } from './runner-protocol.js';

/**
 * 担い手（マネージャー）がクローンへ渡したいファイルを置く「出し箱」の runner 側（Issue #4126 P2a）。
 *
 * **向きは「担い手が出し箱へ写す → runner がターンの終わりの報告のときに取り込む → デーモンが取りに来る」。**
 * runner からデーモンへ押し上げる・取りに行く経路は作らない（デーモンが runner を叩く向きだけ）。中身は SSE に載せない
 * （`report.files` はメタデータだけで、中身は `GET /managers/:id/outbox/:fileId`）。
 *
 * ## 置き場
 *
 * - 出し箱 `<outboxRoot>/<managerId>/`（既定は `os.tmpdir()` 配下の `alteroid-outbox`）。**担い手が書く唯一の場所**。
 *   所有者は runner、グループは担い手の子プロセスの gid、**02770**。子を降ろさない構成は 0700。
 *   `outboxRoot` は runner 所有の **0711**（担い手は自分の dir を辿れるが、他の委譲の出し箱を列挙・作成できない）。
 * - 退避先 `<stagedRoot>/<managerId>/<fileId>`（既定は `alteroid-outbox-staged`）。**runner だけの場所**（dir 0700・file 0400）。
 *   担い手には見えず、取り込んだ後の中身を担い手が書き換えられない。
 *
 * ## 取り込み（{@link collectManagerOutbox}）が安全の要である
 *
 * 出し箱は担い手が自由に書ける。runner（root のことがある）が出し箱の名前を信じて読むと、担い手が
 * 「runner の持ち物（鍵・他の委譲の添付）を指す symlink / ハードリンク」を置いて読ませる経路になる。だから:
 *
 * 1. **直下の名前だけを列挙する**（サブディレクトリは辿らない）。
 * 2. **`O_NOFOLLOW | O_NONBLOCK` で開く。** symlink は `ELOOP` で失敗する。FIFO で読み手が詰まらない。
 * 3. **開いた fd を `fstat` して**通常ファイル・所有者が担い手（降ろさない構成では runner 自身）・リンク数 1 を確かめる。
 *    パス名で検めてから開く形（`lstat` → `open`）にしない: その隙間に担い手が差し替えられる。
 * 4. **開いた fd から**退避先へ写し、同時に sha256 を取る。写したバイト数が `fstat` の大きさと違えば（途中で変わった）断る。
 */

/** 出し箱の root の既定。 */
export function defaultRunnerOutboxRoot(): string {
  return join(tmpdir(), 'alteroid-outbox');
}

/** 退避先の root の既定。 */
export function defaultRunnerOutboxStagedRoot(): string {
  return join(tmpdir(), 'alteroid-outbox-staged');
}

/** 担い手のセッションへ出し箱の場所を渡す環境変数。 */
export const RUNNER_OUTBOX_ENV = 'ALTEROID_OUTBOX';

/** 取り込めなかったものを報告に載せる件数の上限（担い手が大量に置いても報告が膨らまない）。 */
const MAX_REPORTED_REJECTIONS = 100;

/**
 * 1つの委譲の退避先に、デーモンが取りに来ないまま溜めてよい合計（`maxTotalBytes` の倍数）。
 * 旧いデーモンは `files` を読み捨てて取りに来ない（`DELETE` もしない）ので、上限が無いと
 * ターンごとに退避先が増え、`closed` まで器のディスクを食う。
 */
const STAGED_BUDGET_FACTOR = 8;

const COPY_CHUNK_BYTES = 64 * 1024;

const FILE_ID = /^[0-9a-f]{32}$/;

/** 退避先の名前の形か（パス区切りや `..` を通さない）。 */
export function isOutboxFileId(value: string): boolean {
  return FILE_ID.test(value);
}

/** 出し箱・退避先の dir が安全でない（symlink・実在の dir でない・所有者が runner でない）。呼び手は出し箱なしで進む。 */
export class RunnerOutboxUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerOutboxUnsafeError';
  }
}

const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/** `path` が runner 自身の所有の実在の dir（symlink でない）であることを確かめる。`/tmp` は誰でも書けるので毎回見る。 */
function assertOwnDirectorySync(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RunnerOutboxUnsafeError(`${path} が実在の dir でない（symlink か dir 以外）`);
  }
  const uid = ownUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new RunnerOutboxUnsafeError(`${path} の所有者が runner ではない`);
  }
}

function ensureOwnDirectorySync(
  path: string,
  mode: number,
  options: { childGid?: number; recursive?: boolean } = {},
): void {
  try {
    mkdirSync(path, { mode, recursive: options.recursive === true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertOwnDirectorySync(path);
  // `chown` を `chmod` より先にする: 所有グループを変えると setgid が落ちうるため
  // `mkdir` の `mode` に頼らない: umask と setgid ビットは `mkdir` では思いどおりにならない
  if (options.childGid !== undefined) chownSync(path, ownUid() ?? -1, options.childGid);
  chmodSync(path, mode);
}

export interface PrepareManagerOutboxOptions {
  readonly root: string;
  readonly managerId: string;
  /** 担い手の子プロセスの gid（降ろす構成のとき）。無ければ runner と同じ UID で 0700。 */
  readonly childGid?: number;
}

/**
 * その委譲の出し箱を用意して、パスを返す（あれば作り直さず権限だけ整える）。
 * 安全でなければ {@link RunnerOutboxUnsafeError}（呼び手は出し箱を渡さずに進む。出し箱は無くてもマネージャーは動く）。
 */
export function prepareManagerOutbox(options: PrepareManagerOutboxOptions): string {
  const { managerId, childGid } = options;
  if (!isSafeRunnerSegment(managerId)) {
    throw new RunnerOutboxUnsafeError('managerId が dir 名にできない形');
  }
  const base = resolve(options.root);
  // 担い手が自分の dir を辿れるように root だけは x を付ける。r を付けない: 他の委譲の出し箱を列挙させない
  ensureOwnDirectorySync(base, 0o711, { recursive: true });
  const dir = resolve(base, managerId);
  ensureOwnDirectorySync(dir, childGid === undefined ? 0o700 : 0o2770, {
    ...(childGid === undefined ? {} : { childGid }),
  });
  return dir;
}

export interface CollectManagerOutboxOptions {
  readonly root: string;
  readonly stagedRoot: string;
  readonly managerId: string;
  /**
   * 出し箱のファイルの所有者として期待する uid。子を降ろす構成なら子の uid、降ろさない構成なら runner 自身の uid
   * （`undefined` は uid を持たない環境で、所有者を見ない）。ハードリンクで runner の持ち物を指させる経路を塞ぐ。
   */
  readonly expectedUid: number | undefined;
  /** 上限の取り元（`readAttachmentLimits().limits`）。 */
  readonly limits: Pick<AttachmentLimits, 'maxFileBytes' | 'maxPerMessage' | 'maxTotalBytes'>;
  /** テスト用: 最初の1塊を写した直後に呼ぶ（読み途中で担い手が書き換える競りを決定的に作るため）。 */
  readonly afterFirstChunk?: () => Promise<void>;
}

export interface CollectedManagerOutbox {
  readonly files: RunnerOutboxFile[];
  readonly rejectedFiles: RunnerOutboxRejectedFile[];
}

/** 1つを断る。`remove` は出し箱の名前を消す（次の報告で同じ断りを繰り返さない）、`keep` は残す。 */
class OutboxRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly disposition: 'remove' | 'keep',
  ) {
    super(reason);
    this.name = 'OutboxRefusal';
  }
}

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** 拡張子からの推定（中身は見ない）。画像かどうかの最終判定はデーモンの `prepareAttachment` に任せる。 */
export function guessOutboxMediaType(name: string): string {
  return MEDIA_TYPES_BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

async function stagedBytesOf(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let sum = 0;
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info?.isFile()) sum += info.size;
  }
  return sum;
}

/** 名前が今も同じ inode を指しているときだけ消す（開いた後に担い手が差し替えた別のものを巻き込まない）。 */
async function unlinkIfSame(path: string, opened: { dev: number; ino: number }): Promise<void> {
  const now = await lstat(path).catch(() => undefined);
  if (now === undefined || now.dev !== opened.dev || now.ino !== opened.ino) return;
  await unlink(path).catch(() => undefined);
}

interface CollectContext {
  readonly dir: string;
  readonly stagedDir: string;
  readonly expectedUid: number | undefined;
  readonly maxFileBytes: number;
  readonly totalLimit: number;
  totalBytes: number;
  readonly afterFirstChunk?: () => Promise<void>;
}

/** 開いた fd から退避先へ写す。大きさが `size` と違えば（途中で変わった）断って退避先を消す。 */
async function copyToStaged(
  source: FileHandle,
  size: number,
  stagedDir: string,
  afterFirstChunk?: () => Promise<void>,
): Promise<{ fileId: string; sha256: string }> {
  const fileId = randomBytes(16).toString('hex');
  const stagedPath = join(stagedDir, fileId);
  const out = await open(stagedPath, 'wx', 0o400);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      // 1バイト余分に読む: 読んでいる間に伸ばされたことを見つけるため（`size` ちょうどで止めると伸びが見えない）
      const want = Math.min(buffer.length, size - total + 1);
      const { bytesRead } = await source.read(buffer, 0, want, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > size) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await out.write(buffer, written, bytesRead - written);
        written += result.bytesWritten;
      }
      if (total === bytesRead) await afterFirstChunk?.();
    }
    if (total !== size) {
      throw new OutboxRefusal('読んでいる間に大きさが変わった（次の報告で送り直せる）', 'keep');
    }
    return { fileId, sha256: hash.digest('hex') };
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await out.close();
  }
}

async function takeEntry(context: CollectContext, name: string): Promise<RunnerOutboxFile> {
  const path = join(context.dir, name);
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ELOOP は symlink（`O_NOFOLLOW`）。ENXIO は読み手の居ない socket 等
    if (code === 'ELOOP') throw new OutboxRefusal('symlink は送れない', 'remove');
    if (code === 'ENXIO') throw new OutboxRefusal('通常のファイルではない', 'remove');
    throw new OutboxRefusal(`開けなかった（${code ?? '不明'}）`, 'keep');
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) {
      throw new OutboxRefusal('サブディレクトリは送れない（出し箱の直下のファイルだけ）', 'keep');
    }
    if (!info.isFile()) throw new OutboxRefusal('通常のファイルではない', 'remove');
    if (context.expectedUid !== undefined && info.uid !== context.expectedUid) {
      throw new OutboxRefusal('所有者が担い手ではない', 'remove');
    }
    if (info.nlink > 1) throw new OutboxRefusal('ハードリンクは送れない', 'remove');
    if (info.size === 0) throw new OutboxRefusal('空のファイルは送れない', 'remove');
    if (info.size > context.maxFileBytes) {
      throw new OutboxRefusal(`1つの上限（${context.maxFileBytes} バイト）を超える`, 'remove');
    }
    if (context.totalBytes + info.size > context.totalLimit) {
      throw new OutboxRefusal('1回の報告の合計の上限を超える（次の報告で送る）', 'keep');
    }
    const copied = await copyToStaged(
      handle,
      info.size,
      context.stagedDir,
      context.afterFirstChunk,
    );
    context.totalBytes += info.size;
    await unlinkIfSame(path, info);
    return {
      fileId: copied.fileId,
      name,
      mediaType: guessOutboxMediaType(name),
      size: info.size,
      sha256: copied.sha256,
    };
  } finally {
    await handle.close();
  }
}

/**
 * その委譲の出し箱の直下を取り込む（報告を出す直前に呼ぶ）。取り込めた分は退避先へ写して出し箱の名前を消し、
 * 断った分は理由つきで返す。出し箱が無ければ空。呼び手は例外を握ってよい（出し箱の失敗でターンの報告を止めない）。
 *
 * 断った名前の扱い（出し箱から消すか残すか）:
 * - **消す**: symlink・FIFO 等・所有者違い・ハードリンク・空・1つの上限超え。ここで残すと、次の報告のたびに同じ断りが
 *   出続け、しかも直す手段が無い（直すなら担い手が新しく写し直す）。消すのは**名前（dir エントリ）だけ**で、
 *   指す先の中身には触れない（`unlink` は symlink を辿らない）。
 * - **残す**: 個数・合計・退避先の予算で後回しにしたもの（次の報告で送れる）、読み途中で大きさが変わったもの、
 *   サブディレクトリ（中身を辿らない・消さない。`rm -r` は担い手の持ち物を再帰で消す道具になる）。
 *   残したものは `closed` の掃除が消す。
 */
export async function collectManagerOutbox(
  options: CollectManagerOutboxOptions,
): Promise<CollectedManagerOutbox> {
  const { root, stagedRoot, managerId, expectedUid, limits } = options;
  if (!isSafeRunnerSegment(managerId)) return { files: [], rejectedFiles: [] };
  const dir = resolve(root, managerId);
  const info = await lstat(dir).catch(() => undefined);
  // 出し箱が runner 所有の実在の dir でなければ読まない（作った後に差し替えられた形）
  const uid = ownUid();
  if (
    info === undefined ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (uid !== undefined && info.uid !== uid)
  ) {
    return { files: [], rejectedFiles: [] };
  }
  const names = (await readdir(dir)).sort();
  if (names.length === 0) return { files: [], rejectedFiles: [] };

  ensureOwnDirectorySync(resolve(stagedRoot), 0o700, { recursive: true });
  const stagedDir = resolve(stagedRoot, managerId);
  ensureOwnDirectorySync(stagedDir, 0o700);
  const stagedBudget = limits.maxTotalBytes * STAGED_BUDGET_FACTOR;
  const context: CollectContext = {
    dir,
    stagedDir,
    expectedUid,
    maxFileBytes: limits.maxFileBytes,
    totalLimit: Math.min(limits.maxTotalBytes, stagedBudget - (await stagedBytesOf(stagedDir))),
    totalBytes: 0,
    ...(options.afterFirstChunk === undefined ? {} : { afterFirstChunk: options.afterFirstChunk }),
  };

  const files: RunnerOutboxFile[] = [];
  const rejected: RunnerOutboxRejectedFile[] = [];
  let omitted = 0;
  const reject = (name: string, reason: string): void => {
    if (rejected.length < MAX_REPORTED_REJECTIONS) rejected.push({ name, reason });
    else omitted += 1;
  };
  for (const name of names) {
    // 個数の上限に達した後は開かない: 大量に置かれても読む量が増えない
    if (files.length >= limits.maxPerMessage) {
      reject(name, '1回の報告の個数の上限を超える（次の報告で送る）');
      continue;
    }
    try {
      files.push(await takeEntry(context, name));
    } catch (error) {
      if (!(error instanceof OutboxRefusal)) {
        reject(name, '取り込めなかった（理由を取れなかった）');
        continue;
      }
      reject(name, error.reason);
      if (error.disposition === 'remove') await unlink(join(dir, name)).catch(() => undefined);
    }
  }
  if (omitted > 0)
    rejected.push({ name: '(省略)', reason: `ほか ${omitted} 件も取り込まなかった` });
  return { files, rejectedFiles: rejected };
}

export interface StagedOutboxFile {
  readonly size: number;
  readonly stream: Readable;
}

/** 退避先を開く。無い・通常のファイルでない・形が不正なら `undefined`。 */
export async function openStagedOutboxFile(
  stagedRoot: string,
  managerId: string,
  fileId: string,
): Promise<StagedOutboxFile | undefined> {
  if (!isSafeRunnerSegment(managerId) || !isOutboxFileId(fileId)) return undefined;
  const base = resolve(stagedRoot);
  const path = resolve(base, managerId, fileId);
  if (!path.startsWith(base + sep)) return undefined;
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  const info = await handle.stat().catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    await handle.close().catch(() => undefined);
    return undefined;
  }
  return { size: info.size, stream: handle.createReadStream() };
}

/** 退避先を1つ消す（無くても何もしない。冪等）。形が不正なら `false`。 */
export async function removeStagedOutboxFile(
  stagedRoot: string,
  managerId: string,
  fileId: string,
): Promise<boolean> {
  if (!isSafeRunnerSegment(managerId) || !isOutboxFileId(fileId)) return false;
  await rm(resolve(stagedRoot, managerId, fileId), { force: true });
  return true;
}

/** 出し箱の中身（直下の各エントリ）を、子の uid/gid の権限で再帰的に消す。 */
export type OutboxContentsRemover = (
  entries: readonly string[],
  child: { readonly uid: number; readonly gid: number },
) => void;

const REMOVE_CHUNK = 200;

/** 既定: 子の権限の `rm -rf` を走らせる（runner の権限で担い手の木を辿らない）。 */
export const removeOutboxContentsAsChild: OutboxContentsRemover = (entries, child) => {
  for (let i = 0; i < entries.length; i += REMOVE_CHUNK) {
    spawnSync('rm', ['-rf', '--one-file-system', '--', ...entries.slice(i, i + REMOVE_CHUNK)], {
      uid: child.uid,
      gid: child.gid,
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      stdio: 'ignore',
    });
  }
};

export interface OutboxRemovalOptions {
  /** 子を降ろす構成のときの子。無ければ同じ uid で権限差が無いので runner が直接消す。 */
  readonly child?: { readonly uid: number; readonly gid: number };
  /** テスト用の差し替え口。 */
  readonly removeContentsAsChild?: OutboxContentsRemover;
}

/**
 * 出し箱の dir 1つを消す。
 *
 * **子を降ろす構成では、中身を runner の権限で再帰削除しない。** 出し箱は担い手が書ける木で、担い手（や残した背景
 * プロセス）が走査中にサブディレクトリを symlink に差し替えると、runner（root のことがある）の `rm -r` が
 * 出し箱の外を消す（古典的な TOCTOU）。中身は子の権限でだけ消し、runner は空になった dir を非再帰の `rmdir` で
 * 消す（空でなければ残し、次の掃除に任せる）。
 */
function removeOutboxDirectory(dir: string, options: OutboxRemovalOptions): void {
  if (options.child === undefined) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  if (names.length > 0) {
    (options.removeContentsAsChild ?? removeOutboxContentsAsChild)(
      names.map((name) => join(dir, name)),
      options.child,
    );
  }
  try {
    rmdirSync(dir);
  } catch {
    // 空でない・既に無い: 残して次の掃除に任せる
  }
}

/**
 * その委譲の出し箱を消す（無ければ何もしない）。**退避先は消さない**: 最後の報告の直後に `closed` が来るのが普通で、
 * ここで消すとデーモンが取りに来る前に最終報告のファイルが消える。退避先はデーモンの `DELETE` か {@link pruneStaleOutboxRoots} が消す。
 * **同期にしている**: 非同期にすると、同じ managerId の resume が先に出し箱を作り直した後で、遅れて走った消去が
 * 新しい出し箱を巻き込む（下りの添付は `#attachmentRemovals` で待たせているが、ここは待たせる相手が居ない）。
 */
export function removeManagerOutbox(
  root: string,
  managerId: string,
  options: OutboxRemovalOptions = {},
): void {
  if (!isSafeRunnerSegment(managerId)) return;
  const base = resolve(root);
  const dir = resolve(base, managerId);
  if (!dir.startsWith(base + sep)) return;
  removeOutboxDirectory(dir, options);
}

/**
 * 取りこぼしの掃除（添付と同じ基準: 生きた委譲に当たらず、最後に触れてから24時間）。
 * 出し箱の root は {@link removeManagerOutbox} と同じ消し方（子の権限）、退避先の root は runner だけの木なので再帰削除でよい。
 */
export function pruneStaleOutboxRoots(
  roots: { readonly outboxRoot: string; readonly stagedRoot: string },
  liveManagerIds: readonly string[],
  now: number,
  options: OutboxRemovalOptions = {},
  maxAgeMs: number = RUNNER_ATTACHMENT_STALE_MS,
): void {
  for (const [top, isOutbox] of [
    [roots.outboxRoot, true],
    [roots.stagedRoot, false],
  ] as const) {
    let entries: string[];
    try {
      entries = readdirSync(top);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (liveManagerIds.includes(entry)) continue;
      const dir = join(top, entry);
      try {
        const info = lstatSync(dir);
        if (!info.isDirectory() || now - info.mtimeMs <= maxAgeMs) continue;
        if (isOutbox) removeOutboxDirectory(dir, options);
        else rmSync(dir, { recursive: true, force: true });
      } catch {
        // 掃除で新しい仕事を止めない
      }
    }
  }
}
