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

import {
  isAttachmentImageMediaType,
  readRunnerAttachmentStageLimit,
  type AttachmentLimits,
} from './attachment.js';
import { isSafeRunnerSegment, RUNNER_ATTACHMENT_STALE_MS } from './runner-attachments.js';
import type { RunnerOutboxFile, RunnerOutboxRejectedFile } from './runner-protocol.js';

/**
 * 出し箱は担い手が自由に書けるので、取り込み（{@link collectManagerOutbox}）で名前を信じて読まない:
 * runner（root のことがある）に、runner の持ち物を指す symlink / ハードリンクを読ませる経路になるため。
 * パス名で検めてから開く形（`lstat` → `open`）にしない: その隙間に担い手が差し替えられる。
 */

export function defaultRunnerOutboxRoot(): string {
  return join(tmpdir(), 'alteroid-outbox');
}

export function defaultRunnerOutboxStagedRoot(): string {
  return join(tmpdir(), 'alteroid-outbox-staged');
}

export const RUNNER_OUTBOX_ENV = 'ALTEROID_OUTBOX';

const MAX_REPORTED_REJECTIONS = 100;

/** 上限を置く: 旧いデーモンは `files` を読み捨てて取りに来ない（`DELETE` もしない）ので、無いとターンごとに退避先が増え、`closed` まで器のディスクを食う。 */
const STAGED_BUDGET_FACTOR = 8;

/** 大きいファイルの退避先の予算を小さいファイルと同じ8倍にしない: 16 GiB になり、器の `/tmp` を食い尽くしうるため。 */
const LARGE_STAGED_BUDGET_FACTOR = 2;

const COPY_CHUNK_BYTES = 64 * 1024;

const FILE_ID = /^[0-9a-f]{32}$/;

export function isOutboxFileId(value: string): boolean {
  return FILE_ID.test(value);
}

export class RunnerOutboxUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerOutboxUnsafeError';
  }
}

const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

// `/tmp` は誰でも書けるので毎回見る
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
  readonly childGid?: number;
}

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
  /** ハードリンクで runner の持ち物を指させる経路を塞ぐ。`undefined` は uid を持たない環境で、所有者を見ない。 */
  readonly expectedUid: number | undefined;
  readonly limits: Pick<AttachmentLimits, 'maxFileBytes' | 'maxPerMessage' | 'maxTotalBytes'>;
  /** 省略時は `readRunnerAttachmentStageLimit(process.env)`（hello の `attachmentStageLimit` と同じ値）。 */
  readonly maxLargeFileBytes?: number;
  readonly afterFirstChunk?: () => Promise<void>;
}

export interface CollectedManagerOutbox {
  readonly files: RunnerOutboxFile[];
  readonly rejectedFiles: RunnerOutboxRejectedFile[];
}

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

// 中身は見ない: 画像かどうかの最終判定はデーモンの `prepareAttachment` に任せる
export function guessOutboxMediaType(name: string): string {
  return MEDIA_TYPES_BY_EXTENSION[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** 画像は `maxFileBytes` までしか取り込まないので、それを超える退避済みのものは大きいファイルだけと決められる。 */
async function stagedBytesOf(
  dir: string,
  maxFileBytes: number,
): Promise<{ small: number; large: number }> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let small = 0;
  let large = 0;
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > maxFileBytes) large += info.size;
    else small += info.size;
  }
  return { small, large };
}

// 同じ inode のときだけ消す: 開いた後に担い手が差し替えた別のものを巻き込まない
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
  readonly maxLargeFileBytes: number;
  readonly totalLimit: number;
  totalBytes: number;
  readonly largeTotalLimit: number;
  largeTotalBytes: number;
  readonly afterFirstChunk?: () => Promise<void>;
}

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
    // 画像かどうかは拡張子で決める: 中身は見ない（最終判定はデーモン）。画像は大きいファイルにしない
    const image = isAttachmentImageMediaType(guessOutboxMediaType(name));
    const large = !image && info.size > context.maxFileBytes;
    const fileMax = image ? context.maxFileBytes : context.maxLargeFileBytes;
    if (info.size > fileMax) {
      throw new OutboxRefusal(`1つの上限（${fileMax} バイト）を超える`, 'remove');
    }
    if (large) {
      // 大きいファイルは `maxTotalBytes` の合計に数えず、別の予算で見る
      if (context.largeTotalBytes + info.size > context.largeTotalLimit) {
        throw new OutboxRefusal(
          '1回の報告の大きいファイルの合計の上限を超える（次の報告で送る）',
          'keep',
        );
      }
    } else if (context.totalBytes + info.size > context.totalLimit) {
      throw new OutboxRefusal('1回の報告の合計の上限を超える（次の報告で送る）', 'keep');
    }
    const copied = await copyToStaged(
      handle,
      info.size,
      context.stagedDir,
      context.afterFirstChunk,
    );
    if (large) context.largeTotalBytes += info.size;
    else context.totalBytes += info.size;
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
 * 断った名前を消すのは、直しようが無いもの（symlink・FIFO 等・所有者違い・ハードリンク・空・1つの上限超え）だけ:
 * 残すと次の報告のたびに同じ断りが出続ける。消すのは名前（dir エントリ）だけで、指す先には触れない。
 * サブディレクトリは消さない: `rm -r` は担い手の持ち物を再帰で消す道具になる。
 */
export async function collectManagerOutbox(
  options: CollectManagerOutboxOptions,
): Promise<CollectedManagerOutbox> {
  const { root, stagedRoot, managerId, expectedUid, limits } = options;
  if (!isSafeRunnerSegment(managerId)) return { files: [], rejectedFiles: [] };
  const dir = resolve(root, managerId);
  const info = await lstat(dir).catch(() => undefined);
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
  const largeReportLimit = options.maxLargeFileBytes ?? readRunnerAttachmentStageLimit();
  const maxLargeFileBytes = Math.max(limits.maxFileBytes, largeReportLimit);
  const staged = await stagedBytesOf(stagedDir, limits.maxFileBytes);
  const stagedBudget = limits.maxTotalBytes * STAGED_BUDGET_FACTOR;
  const largeStagedBudget = largeReportLimit * LARGE_STAGED_BUDGET_FACTOR;
  const context: CollectContext = {
    dir,
    stagedDir,
    expectedUid,
    maxFileBytes: limits.maxFileBytes,
    maxLargeFileBytes,
    totalLimit: Math.min(limits.maxTotalBytes, stagedBudget - staged.small),
    totalBytes: 0,
    largeTotalLimit: Math.min(largeReportLimit, largeStagedBudget - staged.large),
    largeTotalBytes: 0,
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

export async function removeStagedOutboxFile(
  stagedRoot: string,
  managerId: string,
  fileId: string,
): Promise<boolean> {
  if (!isSafeRunnerSegment(managerId) || !isOutboxFileId(fileId)) return false;
  await rm(resolve(stagedRoot, managerId, fileId), { force: true });
  return true;
}

export type OutboxContentsRemover = (
  entries: readonly string[],
  child: { readonly uid: number; readonly gid: number },
) => void;

const REMOVE_CHUNK = 200;

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
  readonly child?: { readonly uid: number; readonly gid: number };
  readonly removeContentsAsChild?: OutboxContentsRemover;
}

/**
 * 子を降ろす構成では、中身を runner の権限で再帰削除しない: 担い手が走査中にサブディレクトリを symlink に
 * 差し替えると、runner（root のことがある）の `rm -r` が出し箱の外を消す（TOCTOU）。
 * 中身は子の権限でだけ消し、runner は空になった dir を非再帰の `rmdir` で消す。
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
 * 退避先は消さない: 最後の報告の直後に `closed` が来るのが普通で、ここで消すとデーモンが取りに来る前に
 * 最終報告のファイルが消える。
 * 同期にしている: 非同期にすると、同じ managerId の resume が先に出し箱を作り直した後で、遅れて走った消去が
 * 新しい出し箱を巻き込む。
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
