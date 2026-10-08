import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { sha256Hex } from './auth.js';
import { reasonOf } from './dropped-record.js';
import { attachmentDiskName, normalizeAttachmentName, type AttachmentStore } from './attachment.js';

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

/** 掃除が消す前に付ける専用の名前の頭（`SAFE_ID` は先頭が英数なので、取り出しの id とぶつからない）。 */
const PRUNING_PREFIX = '.pruning-';

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
 * `id` の写し（`<copiesDir>/<id>`）を消す。`DELETE /attachments/:id` と `file_delete` が共有する（#4126）。
 * 写しの置き場の形はここだけが知る。ディレクトリ名にできない id（`..`・パス区切り）は何もしない。
 * 本体が無かったときも呼んでよい（本体だけ先に消えて取り残された写しを片付ける）。
 */
export async function removeAttachmentCopy(copiesDir: string, id: string): Promise<void> {
  if (!SAFE_ID.test(id)) return;
  await rm(join(copiesDir, id), { recursive: true, force: true });
}

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
  // ディスク上の名前は NAME_MAX（255 バイト）に収まるよう丸める（#3324）。返す `name`（表示）は丸めない。
  const diskName = attachmentDiskName(name);
  const base = resolve(copiesDir);
  const dir = resolve(base, meta.id);
  const path = resolve(dir, diskName);
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
  // 一時ファイルは名前に依らない短い固定の形（名前に足すと NAME_MAX を超える）。
  const tmp = resolve(dir, `.${randomUUID()}.tmp`);
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
 *
 * 消す前に掃除専用の名前（`.pruning-<uuid>`）へ rename し、「古い」の判定を確かめ直してから消す（#3591）。
 * 判定のあとに {@link fetchAttachmentCopy} が使い回して印を付けていたら、元の名前へ戻す。
 * 閉じる範囲は、同じ置き場を使う取り出しと掃除の競り（同一プロセスの非同期の交錯、別プロセスも同じ順序で効く）。
 * rename の直後から戻すまでの間（ごく短い）は元のパスが無いので、その間に取り出しが使い回しを試みると書き直す。
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
    // 前の周で消し切れず残った掃除専用の名前（取り出しの id は先頭が英数なので、この名前とはぶつからない）。
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
    // 「古い」と判定してから消すまでの間に `fetchAttachmentCopy` が使い回して印（mtime）を付けても、
    // 返したパスを消さないため、先に掃除専用の名前へ rename して取り出しから切り離し、そのうえで印を確かめ直す（#3591）。
    // rename の後は取り出しが同じパスを使い回せない（`readFile` が失敗し、書き直す）。
    const trash = join(copiesDir, `${PRUNING_PREFIX}${randomUUID()}`);
    try {
      await rename(dir, trash);
    } catch {
      continue; // すでに無い。次の周でまた見る。
    }
    try {
      if (stale) {
        const again = await stat(trash).catch(() => undefined);
        if (again !== undefined && !isStale(again.mtimeMs)) {
          // 判定のあとに使われた。元の名前へ戻す。戻せない（その間に書き直された）なら、新しい写しがあるので捨ててよい。
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
      // 1件の失敗で周回を止めない。元の名前へ戻して次の周でまた掃く（戻せなければ掃除専用の名前のまま、次の周の頭で消す）。
      await rename(trash, dir).catch(() => undefined);
      process.stderr.write(
        `alteroidd: 添付の写しを消せませんでした (${entry}): ${reasonOf(error)}\n`,
      );
    }
  }
  return removed;
}
