import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { sha256Hex } from './auth.js';
import { reasonOf } from './dropped-record.js';
import { normalizeAttachmentName, type AttachmentStore } from './attachment.js';

/**
 * 添付の中身をデーモンの手元へ「写し」として取り出す（Issue #3111 段2。`attachment_fetch` の実体）。
 *
 * **置き場**: クローンの cwd（`ALTEROID_HOME`）の配下 `state/attachment-copies/<id>/<名前>`。
 * cwd の中なので、クローンの組み込み `Read` が追加の許可なしで開ける（SDK の `additionalDirectories` や
 * `allowedTools` を足さずに済む。足すと「取り出し先だけ」の範囲でも許可の範囲が広がる）。
 * cwd が分からない器（テスト等）だけ `os.tmpdir()` 配下へ倒す。
 *
 * **写しは写しである。** 正本は `AttachmentStore`。器が作り直されれば消えてよく、掃除
 * （{@link pruneAttachmentCopies}）が古いものと元が消えたものを消す。中身は記憶にも日誌にも写さない。
 */
export const ATTACHMENT_COPIES_SUBDIR = join('state', 'attachment-copies');

/** 写しを残す時間（最後に取り出された/使われたときから）。 */
export const ATTACHMENT_COPY_MAX_AGE_MS = 24 * 60 * 60_000;

/** 写しの置き場（`root` はクローンの cwd = `ALTEROID_HOME`）。 */
export function attachmentCopiesDir(root: string): string {
  return join(root, ATTACHMENT_COPIES_SUBDIR);
}

/** cwd が分からない器（テスト等）での置き場。 */
export function fallbackAttachmentCopiesDir(): string {
  return join(tmpdir(), 'alteroid-attachment-copies');
}

export interface AttachmentCopy {
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  /** 既にあった写しを使い回したか。 */
  readonly reused: boolean;
}

export type AttachmentFetchResult =
  | { readonly ok: true; readonly copy: AttachmentCopy }
  | { readonly ok: false; readonly reason: 'not_found' | 'unsafe' };

/** ディレクトリ名にしてよい id（uuid を想定。パス区切りや `..` を通さない）。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * `id` の添付を `<copiesDir>/<id>/<名前>` へ書き出す。無ければ `not_found`（期限切れ・不在）。
 * すでに同じ sha256 の写しがあれば書かずに使い回す。置き場の失敗は例外のまま投げる（呼び手が `reasonOf` を通す）。
 */
export async function fetchAttachmentCopy(
  stores: { readonly attachments: AttachmentStore },
  copiesDir: string,
  id: string,
): Promise<AttachmentFetchResult> {
  const found = await stores.attachments.get(id);
  if (found === undefined) return { ok: false, reason: 'not_found' };
  const { meta, bytes } = found;
  if (!SAFE_ID.test(meta.id)) return { ok: false, reason: 'unsafe' };
  // 名前は保存時に正規化済みだが、置き場の実装を信じず、ここでも区切りを落とす。
  const name = normalizeAttachmentName(meta.name);
  const base = resolve(copiesDir);
  const dir = resolve(base, meta.id);
  const path = resolve(dir, name);
  if (!dir.startsWith(base + sep) || !path.startsWith(dir + sep)) {
    return { ok: false, reason: 'unsafe' };
  }
  const sha256 = sha256Hex(bytes);
  const copy = (reused: boolean): AttachmentFetchResult => ({
    ok: true,
    copy: { path, name, mediaType: meta.mediaType, size: bytes.length, sha256, reused },
  });

  const existing = await readFile(path).catch(() => undefined);
  if (existing !== undefined && sha256Hex(existing) === sha256) {
    // 使われた印（掃除が「古い」と読まないように）。確かめてから印を付けるまでの間に掃除が消した
    // （印が付けられない・パスが無い）なら、消えたパスを返さず、下で書き直す。
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
    )
      return copy(true);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return copy(false);
}

/**
 * 写しの掃除。①最後に触れてから `maxAgeMs` を過ぎたもの、②元の添付が無くなったもの、を消す。
 * 元の確認で例外が出たものは残す（置き場の一時的な失敗で写しを消さない）。消した件数を返す。
 */
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
    const info = await stat(dir).catch(() => undefined);
    if (info === undefined) continue;
    let drop = now.getTime() - info.mtimeMs > maxAgeMs;
    if (!drop) {
      try {
        drop = (await stores.attachments.getMeta(entry)) === undefined;
      } catch {
        drop = false;
      }
    }
    if (drop) {
      try {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        // 1件の失敗で周回を止めない（残りは次の周でまた掃く）。
        process.stderr.write(
          `alteroidd: 添付の写しを消せませんでした (${entry}): ${reasonOf(error)}\n`,
        );
      }
    }
  }
  return removed;
}
