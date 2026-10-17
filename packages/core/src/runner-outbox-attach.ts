import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import {
  isAttachmentImageMediaType,
  readRunnerAttachmentStageLimit,
  type AttachmentLimits,
} from './attachment.js';
import {
  assertOwnDirectorySync,
  guessOutboxMediaType,
  RunnerOutboxUnsafeError,
} from './runner-outbox.js';
import { isSafeRunnerSegment } from './runner-attachments.js';

/**
 * 担い手が名指ししたファイルを、runner が自分で開いて出し箱の直下へ写す（`report_attach`）。
 * 担い手に `cp` を打たせない: Claude Code の auto mode 分類器が出し箱への `cp` を持ち出しとして止めるため（#5018）。
 * 分類器は緩めない。代わりに、runner が読むのは担い手の作業場の下だけに絞る: runner（root のことがある）は
 * 担い手が読めない物（資格の置き場など）も読めるので、名前を信じて開くと、それを報告に添えて持ち出させる道具になる。
 * パス名で検めてから開く形（`lstat` → `open`）にしない: その隙間に担い手が差し替えられる。開いた fd で検める。
 */

export interface AttachToOutboxOptions {
  readonly outboxRoot: string;
  readonly managerId: string;
  /** 担当の作業場の置き場（`/tmp`）。`<scratchParent>/<scratchName>` と `<scratchParent>/<scratchName>-*` の下だけを読む。 */
  readonly scratchParent: string;
  /** `managerScratchDirOf` の末尾（`mgr-<先頭8桁>`） */
  readonly scratchName: string;
  /** `undefined` は uid を持たない環境で、所有者を見ない。 */
  readonly expectedUid: number | undefined;
  /** 写したファイルの持ち主を担い手の子へ渡す（取り込みが所有者を見るため）。子を降ろさない構成では省く。 */
  readonly chownTo?: { readonly uid: number; readonly gid: number };
  readonly limits: Pick<AttachmentLimits, 'maxFileBytes' | 'maxPerMessage' | 'maxTotalBytes'>;
  readonly maxLargeFileBytes?: number;
  readonly paths: readonly string[];
}

export type AttachToOutboxResult =
  | { readonly path: string; readonly ok: true; readonly name: string; readonly size: number }
  | { readonly path: string; readonly ok: false; readonly reason: string };

const COPY_CHUNK_BYTES = 64 * 1024;
const MAX_NAME_ALIAS = 99;

class AttachRefusal extends Error {}

const refuse = (reason: string): never => {
  throw new AttachRefusal(reason);
};

function hasPlainSegments(path: string): boolean {
  if (path.includes('\0') || !path.startsWith('/') || path.endsWith('/')) return false;
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

interface WorkRoot {
  /** 名指されたパスの、作業場にあたる先頭部分 */
  readonly lexical: string;
  /** その実体のパスとして期待するもの。開いた fd の実体のパスが、この下の同じ並びでなければ断る。 */
  readonly real: string;
}

async function matchWorkRoot(
  path: string,
  options: AttachToOutboxOptions,
): Promise<WorkRoot | undefined> {
  const parent = resolve(options.scratchParent);
  if (path.startsWith(`${parent}/`)) {
    const segment = path.slice(parent.length + 1).split('/')[0] ?? '';
    if (
      path.length > parent.length + 1 + segment.length &&
      (segment === options.scratchName || segment.startsWith(`${options.scratchName}-`))
    ) {
      const realParent = await realpath(parent).catch(() => undefined);
      if (realParent === undefined) return undefined;
      return { lexical: join(parent, segment), real: join(realParent, segment) };
    }
  }
  // 担当の cwd の下は読まない: cwd は他の担当と共有で（誰かのチェックアウトのこともある）、担い手の uid が同じなら他の担当のファイルまで報告に添えられるため。作業は `/tmp/mgr-<先頭8桁>` の下でする（システムプロンプトの案内と同じ線）
  return undefined;
}

/** 開いた fd の実体のパス。Linux 以外では、パスを引き直して同じ inode のときだけ信じる。 */
async function actualPathOf(handle: FileHandle, path: string): Promise<string | undefined> {
  const viaProc = await readlink(`/proc/self/fd/${String(handle.fd)}`).catch(() => undefined);
  if (viaProc !== undefined) return viaProc;
  const real = await realpath(path).catch(() => undefined);
  if (real === undefined) return undefined;
  const [opened, resolved] = await Promise.all([handle.stat(), lstat(real).catch(() => undefined)]);
  return resolved !== undefined && resolved.dev === opened.dev && resolved.ino === opened.ino
    ? real
    : undefined;
}

interface Budget {
  count: number;
  small: number;
  large: number;
  readonly maxFileBytes: number;
  readonly maxLargeFileBytes: number;
  readonly maxPerMessage: number;
  readonly maxTotalBytes: number;
  readonly largeTotalLimit: number;
}

async function outboxBudget(dir: string, options: AttachToOutboxOptions): Promise<Budget> {
  const { limits } = options;
  const largeReportLimit = options.maxLargeFileBytes ?? readRunnerAttachmentStageLimit();
  const budget: Budget = {
    count: 0,
    small: 0,
    large: 0,
    maxFileBytes: limits.maxFileBytes,
    maxLargeFileBytes: Math.max(limits.maxFileBytes, largeReportLimit),
    maxPerMessage: limits.maxPerMessage,
    maxTotalBytes: limits.maxTotalBytes,
    largeTotalLimit: largeReportLimit,
  };
  // 出し箱に既に在るぶんも数える: 取り込みは1報告ごとに上限を見るので、写す側が上限なしに積めると出し箱が膨らむ
  for (const name of await readdir(dir)) {
    budget.count += 1;
    const info = await lstat(join(dir, name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > limits.maxFileBytes) budget.large += info.size;
    else budget.small += info.size;
  }
  return budget;
}

async function createDestination(
  dir: string,
  sourceName: string,
): Promise<{ handle: FileHandle; name: string }> {
  const ext = extname(sourceName);
  const stem = ext === '' ? sourceName : sourceName.slice(0, -ext.length);
  for (let n = 1; n <= MAX_NAME_ALIAS; n += 1) {
    const name = n === 1 ? sourceName : `${stem}-${String(n)}${ext}`;
    try {
      // `wx`（O_EXCL）は symlink も辿らない: 担い手が出し箱に置いた symlink の先へは書かない
      const handle = await open(join(dir, name), 'wx', 0o640);
      return { handle, name };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return refuse(
    '出し箱に同じ名前のファイルが多すぎる（出し箱の中身が取り込まれるのを待つか、名前を変えて置き直す）',
  );
}

async function copyInto(source: FileHandle, size: number, out: FileHandle): Promise<void> {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let total = 0;
  for (;;) {
    // 1バイト余分に読む: 読んでいる間に伸ばされたことを見つけるため
    const want = Math.min(buffer.length, size - total + 1);
    const { bytesRead } = await source.read(buffer, 0, want, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > size) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await out.write(buffer, written, bytesRead - written);
      written += result.bytesWritten;
    }
  }
  if (total !== size)
    refuse('読んでいる間に大きさが変わった（書き終わってから、もう一度名指しする）');
}

async function attachOne(
  path: string,
  dir: string,
  budget: Budget,
  options: AttachToOutboxOptions,
): Promise<{ name: string; size: number }> {
  if (!hasPlainSegments(path)) {
    return refuse(
      '絶対パスで、`..`・`.`・重複した `/`・末尾の `/` を含まない形にする（作業場の下のファイルを正規のパスで名指す）',
    );
  }
  const root = await matchWorkRoot(path, options);
  if (root === undefined) {
    return refuse(
      `作業場の外は写せない（写せるのは ${join(options.scratchParent, options.scratchName)} と ${join(options.scratchParent, options.scratchName)}-* の下だけ）。成果物を作業場の下へ置いてから名指しする`,
    );
  }
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return refuse('symlink は写せない（実体のファイルのパスを名指す）');
    if (code === 'ENOENT') return refuse('ファイルが無い');
    return refuse(`開けなかった（${code ?? '不明'}）`);
  }
  try {
    // 親ディレクトリの symlink は `O_NOFOLLOW` では見えない。開いた fd の実体が、作業場の下の同じ並びのままか見る
    const actual = await actualPathOf(handle, path);
    const expected = join(root.real, path.slice(root.lexical.length + 1));
    if (actual !== expected) {
      return refuse(
        '途中のディレクトリが symlink で、実体が作業場の外を指しうる（symlink を含まない実体のパスで名指す）',
      );
    }
    const info = await handle.stat();
    if (info.isDirectory()) return refuse('ディレクトリは写せない（ファイルを1つずつ名指す）');
    if (!info.isFile()) return refuse('通常のファイルではない');
    if (options.expectedUid !== undefined && info.uid !== options.expectedUid) {
      return refuse('所有者が担い手ではない');
    }
    if (info.nlink > 1)
      return refuse('ハードリンクは写せない（`cp` で別のファイルとして作り直す）');
    if (info.size === 0) return refuse('空のファイルは写せない');
    const name0 = basename(path);
    const image = isAttachmentImageMediaType(guessOutboxMediaType(name0));
    const large = !image && info.size > budget.maxFileBytes;
    const fileMax = image ? budget.maxFileBytes : budget.maxLargeFileBytes;
    if (info.size > fileMax) return refuse(`1つの上限（${String(fileMax)} バイト）を超える`);
    if (large) {
      if (budget.large + info.size > budget.largeTotalLimit) {
        return refuse(
          '大きいファイルの合計の上限を超える（出し箱に在るぶんが報告で取り込まれてから、もう一度名指しする）',
        );
      }
    } else if (budget.small + info.size > budget.maxTotalBytes) {
      return refuse(
        '1回の報告の合計の上限を超える（出し箱に在るぶんが報告で取り込まれてから、もう一度名指しする）',
      );
    }
    const dest = await createDestination(dir, name0);
    try {
      if (options.chownTo !== undefined) {
        await dest.handle.chown(options.chownTo.uid, options.chownTo.gid);
      }
      await copyInto(handle, info.size, dest.handle);
    } catch (error) {
      await dest.handle.close().catch(() => undefined);
      await unlink(join(dir, dest.name)).catch(() => undefined);
      throw error;
    }
    await dest.handle.close();
    budget.count += 1;
    if (large) budget.large += info.size;
    else budget.small += info.size;
    return { name: dest.name, size: info.size };
  } finally {
    await handle.close();
  }
}

/** 1件ずつ結果を返す。1件の断りで残りを止めない。 */
export async function attachToManagerOutbox(
  options: AttachToOutboxOptions,
): Promise<AttachToOutboxResult[]> {
  if (!isSafeRunnerSegment(options.managerId)) {
    throw new RunnerOutboxUnsafeError('managerId が dir 名にできない形');
  }
  const dir = resolve(options.outboxRoot, options.managerId);
  assertOwnDirectorySync(dir);
  const budget = await outboxBudget(dir, options);
  const results: AttachToOutboxResult[] = [];
  for (const path of options.paths) {
    try {
      // 個数の上限に達した後は開かない
      if (budget.count >= budget.maxPerMessage) {
        refuse(
          `1回の報告の個数の上限（${String(budget.maxPerMessage)}）を超える（出し箱に在るぶんが報告で取り込まれてから、もう一度名指しする）`,
        );
      }
      const done = await attachOne(path, dir, budget, options);
      results.push({ path, ok: true, ...done });
    } catch (error) {
      results.push({
        path,
        ok: false,
        reason:
          error instanceof AttachRefusal ? error.message : '写せなかった（理由を取れなかった）',
      });
    }
  }
  return results;
}
