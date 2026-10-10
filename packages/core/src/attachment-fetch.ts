import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { reasonOf } from './dropped-record.js';
import { attachmentDiskName, normalizeAttachmentName, type AttachmentStore } from './attachment.js';

// cwd の外へ置かない: SDK の additionalDirectories / allowedTools を足すと、取り出し先だけでも許可の範囲が広がるため
export const ATTACHMENT_COPIES_SUBDIR = join('state', 'attachment-copies');

export const ATTACHMENT_COPY_MAX_AGE_MS = 24 * 60 * 60_000;

// 先頭を `.` にする: `SAFE_ID` は先頭が英数なので、取り出しの id とぶつからない
const PRUNING_PREFIX = '.pruning-';

export function attachmentCopiesDir(root: string): string {
  return join(root, ATTACHMENT_COPIES_SUBDIR);
}

export function fallbackAttachmentCopiesDir(): string {
  return join(tmpdir(), 'alteroid-attachment-copies');
}

export interface AttachmentCopy {
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly reused: boolean;
}

export type AttachmentFetchResult =
  | { readonly ok: true; readonly copy: AttachmentCopy }
  | { readonly ok: false; readonly reason: 'not_found' | 'unsafe' | 'mismatch' };

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest('hex');
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// ディレクトリ名にできない id（`..`・パス区切り）は何もしない。本体が無かったときも呼んでよい（取り残された写しを片付けるため）
export async function removeAttachmentCopy(copiesDir: string, id: string): Promise<void> {
  if (!SAFE_ID.test(id)) return;
  await rm(join(copiesDir, id), { recursive: true, force: true });
}

/** `id` の添付を `<copiesDir>/<id>/<名前>` へ書き出す。同じ sha256 の写しがあれば使い回す。 */
export async function fetchAttachmentCopy(
  stores: { readonly attachments: AttachmentStore },
  copiesDir: string,
  id: string,
): Promise<AttachmentFetchResult> {
  const found = await stores.attachments.open(id);
  if (found === undefined) return { ok: false, reason: 'not_found' };
  try {
    return await copyOpenedAttachment(found, copiesDir);
  } catch (error) {
    // 開いたあとのどこで投げても閉じる（fs は記述子、S3 は応答の本文が残る）。二重の destroy は無害
    found.stream.destroy();
    throw error;
  }
}

async function copyOpenedAttachment(
  found: NonNullable<Awaited<ReturnType<AttachmentStore['open']>>>,
  copiesDir: string,
): Promise<AttachmentFetchResult> {
  const { meta, stream } = found;
  if (!SAFE_ID.test(meta.id)) {
    stream.destroy();
    return { ok: false, reason: 'unsafe' };
  }
  // 保存時に正規化済みでも省かない: 置き場の実装を信じず、ここでも区切りを落とす
  const name = normalizeAttachmentName(meta.name);
  // 丸めるのはディスク上の名前だけ: NAME_MAX（255 バイト）に収めるため。返す `name`（表示）は丸めない
  const diskName = attachmentDiskName(name);
  const base = resolve(copiesDir);
  const dir = resolve(base, meta.id);
  const path = resolve(dir, diskName);
  if (!dir.startsWith(base + sep) || !path.startsWith(dir + sep)) {
    stream.destroy();
    return { ok: false, reason: 'unsafe' };
  }
  const copy = (reused: boolean, size: number, sha256: string): AttachmentFetchResult => ({
    ok: true,
    copy: { path, name, mediaType: meta.mediaType, size, sha256, reused },
  });

  const existingMatches = await stat(path).then(
    async (info) =>
      info.isFile() && info.size === meta.size && (await fileSha256(path)) === meta.sha256,
    () => false,
  );
  if (existingMatches) {
    // 印が付けられない・パスが無いなら返さず書き直す: 確かめてから印を付けるまでの間に掃除が消したため
    const now = new Date();
    const touched = await utimes(dir, now, now).then(
      () => true,
      () => false,
    );
    if (
      touched &&
      (await stat(path).then(
        () => true,
        () => false,
      ))
    ) {
      stream.destroy();
      return copy(true, meta.size, meta.sha256);
    }
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 一時ファイル名に名前を足さない: NAME_MAX を超えるため
  const tmp = resolve(dir, `.${randomUUID()}.tmp`);
  try {
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      stream,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(tmp, { mode: 0o600 }),
    );
    const digest = hash.digest('hex');
    // 置き場が途中で切れて例外なしに終わっても、欠けた写しを「取れた」と言わない: 担い手が壊れたファイルで作業を進めるため
    if (size !== meta.size || digest !== meta.sha256) {
      await rm(tmp, { force: true }).catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      stream.destroy();
      return { ok: false, reason: 'mismatch' };
    }
    await rename(tmp, path);
    return copy(false, size, digest);
  } catch (error) {
    stream.destroy();
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 期限切れ・元が消えた写しを消し、消した件数を返す。 */
export async function pruneAttachmentCopies(
  stores: { readonly attachments: AttachmentStore },
  copiesDir: string,
  now: Date,
  maxAgeMs: number = ATTACHMENT_COPY_MAX_AGE_MS,
): Promise<number> {
  const entries = await readdir(copiesDir).catch(() => [] as string[]);
  let removed = 0;
  for (const entry of entries) {
    const dir = join(copiesDir, entry);
    if (entry.startsWith(PRUNING_PREFIX)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    const info = await stat(dir).catch(() => undefined);
    if (info === undefined) continue;
    const isStale = (mtimeMs: number): boolean => now.getTime() - mtimeMs > maxAgeMs;
    const stale = isStale(info.mtimeMs);
    let drop = stale;
    if (!drop) {
      try {
        drop = (await stores.attachments.getMeta(entry)) === undefined;
      } catch {
        drop = false;
      }
    }
    if (!drop) continue;
    // 直接 rm しない: 判定から消すまでの間に `fetchAttachmentCopy` が使い回して印を付けても、返したパスを消さないため、先に rename して切り離す
    const trash = join(copiesDir, `${PRUNING_PREFIX}${randomUUID()}`);
    try {
      await rename(dir, trash);
    } catch {
      continue;
    }
    try {
      if (stale) {
        const again = await stat(trash).catch(() => undefined);
        if (again !== undefined && !isStale(again.mtimeMs)) {
          const restored = await rename(trash, dir).then(
            () => true,
            () => false,
          );
          if (restored) continue;
        }
      }
      await rm(trash, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      // 1件の失敗で周回を止めない: 元の名前へ戻して次の周でまた掃く
      await rename(trash, dir).catch(() => undefined);
      process.stderr.write(
        `alteroidd: 添付の写しを消せませんでした (${entry}): ${reasonOf(error)}\n`,
      );
    }
  }
  return removed;
}
