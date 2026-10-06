import { randomUUID } from 'node:crypto';
import { chown, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { AgentInputImage, AgentUserInput } from './agent-session.js';
import {
  attachmentDiskName,
  normalizeAttachmentName,
  sniffAttachmentImageType,
  type AttachmentLimits,
  formatImageLimit,
  readAttachmentLimits,
} from './attachment.js';
import { sha256Hex } from './auth.js';
import { stripNul } from './nul-guard.js';
import type { RunnerAttachment } from './runner-protocol.js';

/**
 * 担い手（マネージャー）へ渡す添付を、runner の器に置いて、入力にする（Issue #3111 段3）。
 *
 * **向きは「デーモンが押し込む」だけ。** 中身は命令の本文に載って届く（`runnerAttachmentSchema`）。
 * runner は記憶ストアにも、デーモンのファイルシステムにも触れない。ここは受け取った中身を
 * **sha256 と照合して**から置く。
 *
 * ## 置き場
 *
 * `<root>/<managerId>/<id>/<正規化済み名>`（`root` の既定は `os.tmpdir()` 配下の `alteroid-attachments`。
 * 作業ディレクトリの外・`/tmp/mgr-*` の外なので、作業場の片付け（`scratch-sweep.ts`）の対象にならない）。
 *
 * - **所有者は runner（本体）のまま、グループを担い手の子プロセスの gid にして、dir は 0750・ファイルは 0440。**
 *   担い手は読めるが、書き換え・差し替え・名前の付け替えはできない。**担い手に書ける dir を作らない**のが要点で、
 *   runner（root）がファイルを書く先を、担い手が symlink に差し替える経路（特権の踏み台）を構造で塞ぐ。
 *   子プロセスを降ろさない構成（ローカル。`childUser` 無し）は、同じ UID なので 0700 / 0400。
 * - `root` と各 dir が **runner 自身の所有の実在の dir（symlink でない）** であることを確かめてから使う
 *   （`/tmp` は誰でも書けるので、担い手が先に同名の symlink を置いておく経路を断つ）。
 * - `id` と `managerId` は dir 名にしてよい形だけ（`..` や区切りを通さない）。名前は
 *   {@link normalizeAttachmentName} を通し、ディスク上の名前は {@link attachmentDiskName}（UTF-8 で 200 バイトまで）で丸め、解決後のパスが置き場の外へ出ないことをここでも確かめる。
 *
 * ## 掃除
 *
 * 委譲が終わったとき（`removeManagerAttachments`。`RunnerHost` が `closed` で呼ぶ）に、その委譲の dir ごと消す。
 * 取りこぼし（runner の異常終了など）は {@link pruneStaleAttachmentDirs}（生きた委譲に当たらず、最後に触れてから
 * 猶予を過ぎたもの）が消す。
 */

/** 置き場の既定（`os.tmpdir()` 配下）。 */
export function defaultRunnerAttachmentsRoot(): string {
  return join(tmpdir(), 'alteroid-attachments');
}

/** 取りこぼしの dir を消す猶予（最後に触れてから）。 */
export const RUNNER_ATTACHMENT_STALE_MS = 24 * 60 * 60_000;

/** dir 名にしてよい id（uuid・`mgr-…` を想定。区切りや `..` を通さない）。 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 命令の本文に添えてよい分の余裕（依頼文・JSON の枠）。 */
const BODY_SLACK_BYTES = 2 * 1024 * 1024;
/** 添付1つあたりの JSON のメタデータ分の見積もり。 */
const PER_ATTACHMENT_OVERHEAD_BYTES = 4096;

/**
 * runner の `POST /managers` と `/managers/:id/messages` が受ける本文の上限（バイト）。
 * `POST /managers/:id/resume` も同じ値で検める——ただし生ログ `entries`（添付の上限と無関係に大きい）も
 * 運ぶので、本文全体ではなく **添付の `data` の合計だけ**を比べる（`entries` は対象外）。
 *
 * 添付の合計上限（`maxTotalBytes`）の base64（×4/3）に、個数ぶんのメタデータと依頼文の余裕を足す。
 * **デーモンが添付の上限（個数・合計）を先に検めて送るので、これは「検めを抜けた巨大な本文」への最後の歯止め**
 * であって、能力の上限ではない。runner とデーモンは環境が別なので、上限の環境変数
 * （`ALTEROID_ATTACHMENT_MAX_*`）を上げるときは両方に同じ値を置くこと。
 */
export function runnerAttachmentBodyLimit(limits: AttachmentLimits): number {
  return (
    Math.ceil((limits.maxTotalBytes * 4) / 3) +
    limits.maxPerMessage * PER_ATTACHMENT_OVERHEAD_BYTES +
    BODY_SLACK_BYTES
  );
}

/** 受け取った添付を置けなかった（形が不正・id の重複・中身が sha256 と合わない・置き場が安全でない）。呼び手は 4xx にする。 */
export class RunnerAttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerAttachmentRejectedError';
  }
}

export interface PlacedAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  /** 置いたパス（担い手が `Read` で開ける）。 */
  readonly path: string;
  /** 画像として渡す分（中身の先頭で確かめた画像で、画像の上限以内のものだけ）。 */
  readonly image?: AgentInputImage;
  /** 中身は画像だが画像の上限を超えるので渡さなかった。そのときの上限（バイト。#3325）。 */
  readonly imageOverLimit?: number;
}

export interface PlaceAttachmentsOptions {
  /** 置き場。 */
  readonly root: string;
  readonly managerId: string;
  readonly attachments: readonly RunnerAttachment[];
  /** 担い手の子プロセスの gid（降ろす構成のとき）。無ければ runner と同じ UID で、0700 / 0400。 */
  readonly childGid?: number;
  /** 画像の上限の取り元。既定は runner の環境変数（{@link readAttachmentLimits}。担い手の置き場が読むものと同じ）。 */
  readonly limits?: AttachmentLimits;
}

const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

/** `path` が runner 自身の所有の実在の dir（symlink でない）であることを確かめる。 */
async function assertOwnDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RunnerAttachmentRejectedError(
      `添付の置き場 ${path} が実在の dir でない（symlink か dir 以外）。置かない`,
    );
  }
  const uid = ownUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new RunnerAttachmentRejectedError(
      `添付の置き場 ${path} の所有者が runner ではない。置かない`,
    );
  }
}

/** dir を用意する。**この呼び出しが実際に作った（EEXIST でなかった）ときだけ `true`**（Issue #3268。失敗時の掃除の対象を決める）。 */
async function ensureDirectory(
  path: string,
  mode: number,
  childGid: number | undefined,
): Promise<boolean> {
  let madeHere = true;
  await mkdir(path, { mode }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    madeHere = false;
  });
  await assertOwnDirectory(path);
  if (childGid !== undefined) await chown(path, ownUid() ?? -1, childGid);
  return madeHere;
}

/**
 * 添付を置く。**1つでも不正（形・sha256・置き場）なら例外を投げ、その委譲の dir に半端なものを残さない**
 * （投げる前に置いた分は、この呼び出しが消す）。
 */
export async function placeRunnerAttachments(
  options: PlaceAttachmentsOptions,
): Promise<PlacedAttachment[]> {
  const { root, managerId, attachments, childGid } = options;
  const maxImageBytes = (options.limits ?? readAttachmentLimits().limits).maxImageBytes;
  if (!SAFE_SEGMENT.test(managerId)) {
    throw new RunnerAttachmentRejectedError('managerId が dir 名にできない形');
  }
  if (attachments.length === 0) return [];
  // 先に全部を検める（置く前に落とす）。
  const seenIds = new Set<string>();
  const decoded = attachments.map((attachment) => {
    if (!SAFE_SEGMENT.test(attachment.id)) {
      throw new RunnerAttachmentRejectedError(`添付の id が dir 名にできない形: ${attachment.id}`);
    }
    // 同じ id は同じ置き先（`<id>/<名前>`）を指す。後のものが先のものを上書きし、通知行の sha256 が path の中身と合わなくなる。
    if (seenIds.has(attachment.id)) {
      throw new RunnerAttachmentRejectedError(`添付の id が重複している: ${attachment.id}`);
    }
    seenIds.add(attachment.id);
    const bytes = Buffer.from(attachment.data, 'base64');
    if (bytes.length !== attachment.size || sha256Hex(bytes) !== attachment.sha256) {
      throw new RunnerAttachmentRejectedError(
        `添付 ${attachment.id} の中身が size / sha256 と合わない（置かない）`,
      );
    }
    return { attachment, bytes };
  });

  const base = resolve(root);
  const managerDir = resolve(base, managerId);
  const dirMode = childGid === undefined ? 0o700 : 0o750;
  const fileMode = childGid === undefined ? 0o400 : 0o440;
  // この呼び出しが作った dir と、置いたファイルだけを積む（以前のメッセージが置いた同じ id の dir は消さない）。
  const created: string[] = [];
  const placedFiles: string[] = [];
  const placed: PlacedAttachment[] = [];
  try {
    await mkdir(base, { recursive: true, mode: 0o755 });
    await assertOwnDirectory(base);
    // 担い手が dir を辿れるように、置き場の root だけは誰でも辿れる（中身は 0750 の dir の奥）。
    await ensureDirectory(managerDir, dirMode, childGid);
    for (const { attachment, bytes } of decoded) {
      const name = normalizeAttachmentName(attachment.name);
      const dir = resolve(managerDir, attachment.id);
      // ディスク上の名前は NAME_MAX に収まるよう丸める（#3324）。`name`（通知行・画像の名前）は丸めない。
      const path = resolve(dir, attachmentDiskName(name));
      if (!dir.startsWith(managerDir + sep) || !path.startsWith(dir + sep)) {
        throw new RunnerAttachmentRejectedError(
          `添付 ${attachment.id} の置き先が置き場の外へ出る形だった`,
        );
      }
      if (await ensureDirectory(dir, dirMode, childGid)) created.push(dir);
      const tmp = resolve(dir, `.${randomUUID()}.tmp`);
      try {
        // `wx`（O_EXCL）は symlink を辿らない。
        const handle = await open(tmp, 'wx', fileMode);
        try {
          await handle.writeFile(bytes);
          if (childGid !== undefined) await handle.chown(ownUid() ?? -1, childGid);
        } finally {
          await handle.close();
        }
        await rename(tmp, path);
        placedFiles.push(path);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      const imageType = sniffAttachmentImageType(bytes);
      placed.push({
        id: attachment.id,
        name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        sha256: attachment.sha256,
        path,
        ...(imageType === undefined
          ? {}
          : bytes.length > maxImageBytes
            ? { imageOverLimit: maxImageBytes }
            : // 受け取った文字列（改行・空白・url-safe を黙って許す復号）ではなく、検めた bytes から作り直した正規の base64。
              {
                image: { mediaType: imageType, data: Buffer.from(bytes).toString('base64'), name },
              }),
      });
    }
  } catch (error) {
    // 既存の dir の中では、この呼び出しが置いたファイルだけを消す。新しく作った dir は丸ごと消す。
    for (const file of placedFiles) await rm(file, { force: true }).catch(() => undefined);
    for (const dir of created)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return placed;
}

/** 通知行（添付ごとに1行）。 */
export function placedAttachmentNoticeLine(placed: PlacedAttachment): string {
  return (
    `[添付] id=${placed.id} name=${stripNul(placed.name)} type=${placed.mediaType} ` +
    `size=${placed.size} sha256=${placed.sha256} path=${placed.path}` +
    (placed.imageOverLimit === undefined
      ? `${placed.image === undefined ? '' : '（画像としても渡した）'}（Read で開ける）`
      : `（画像の上限（${formatImageLimit(placed.imageOverLimit)}）を超えるので画像としては渡していない。path で Read で開ける）`)
  );
}

/** 本文に通知行を足し、画像は `images` に入れる。添付が無ければ `{ text }` のまま。 */
export function composeAttachmentInput(
  text: string,
  placed: readonly PlacedAttachment[],
): AgentUserInput {
  if (placed.length === 0) return { text };
  const images = placed.flatMap((item) => (item.image === undefined ? [] : [item.image]));
  const body = `${text}\n\n${placed.map(placedAttachmentNoticeLine).join('\n')}`;
  return images.length === 0 ? { text: body } : { text: body, images };
}

/** その委譲の置き場を消す（無ければ何もしない）。 */
export async function removeManagerAttachments(root: string, managerId: string): Promise<void> {
  if (!SAFE_SEGMENT.test(managerId)) return;
  const base = resolve(root);
  const dir = resolve(base, managerId);
  if (!dir.startsWith(base + sep)) return;
  await rm(dir, { recursive: true, force: true });
}

/**
 * 取りこぼしの掃除。生きた委譲に当たらず、最後に触れてから `maxAgeMs` を過ぎた dir を消す。
 * 消した件数を返す。失敗は握る（掃除で新しい仕事を止めない）。
 */
export async function pruneStaleAttachmentDirs(
  root: string,
  liveManagerIds: readonly string[],
  now: number,
  maxAgeMs: number = RUNNER_ATTACHMENT_STALE_MS,
): Promise<number> {
  const entries = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const entry of entries) {
    if (liveManagerIds.includes(entry)) continue;
    const dir = join(root, entry);
    const info = await stat(dir).catch(() => undefined);
    if (info === undefined || now - info.mtimeMs <= maxAgeMs) continue;
    await rm(dir, { recursive: true, force: true }).then(
      () => {
        removed += 1;
      },
      () => undefined,
    );
  }
  return removed;
}
