import {
  AttachmentRejectedError,
  attachmentBatchItemOf,
  isLargeAttachment,
  validateAttachmentBatch,
  type AttachmentLimits,
  type AttachmentStore,
} from './attachment.js';
import { reasonOf } from './dropped-record.js';
import type { RunnerAttachment } from './runner-protocol.js';
import type { AttachmentRef } from './schema.js';

/**
 * クローンが担い手（マネージャー）へ添付を引き渡す、デーモン側の段取り（Issue #3111 段3）。
 *
 * `manager_start` / `manager_send` の `attachments`（添付の id）を、**この順**で処理する。
 *
 * 1. `getMeta` で全部の存在を確かめる（1つでも無ければ、どれが無いかを言って断る。命令は送らない）
 * 2. 上限（個数・合計。`validateAttachmentBatch` ＝ 人間の発言と同じ上限）を確かめる
 * 3. `get` で中身を読み、base64 にして命令の本文に載せる形（{@link RunnerAttachment}）にする
 *
 * 断るときは例外ではなく `ok: false` と文を返す（呼び手の道具がそのまま本文にする。エラー文は `reasonOf` を通す）。
 * **中身はここで読むだけで、記憶・日誌には写さない**（日誌へは {@link attachmentRefsOf} のメタデータだけ）。
 */
export type LoadedManagerAttachments =
  | { readonly ok: true; readonly attachments: RunnerAttachment[] }
  | { readonly ok: false; readonly message: string };

export async function loadManagerAttachments(
  stores: { readonly attachments: AttachmentStore },
  ids: readonly string[],
  limits: AttachmentLimits,
): Promise<LoadedManagerAttachments> {
  // 同じ id を2度渡されても1つにする（置き場の dir が id なので、重ねても得るものが無い）。
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, attachments: [] };

  const metas = [];
  const missing: string[] = [];
  for (const id of unique) {
    let meta;
    try {
      meta = await stores.attachments.getMeta(id);
    } catch (error) {
      return { ok: false, message: `添付 ${id} の控えを読めなかった: ${reasonOf(error)}` };
    }
    if (meta === undefined) missing.push(id);
    else metas.push(meta);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `添付が見つからない（保持期限が過ぎて消えた、または id の誤り）: ${missing.join(', ')}。` +
        '担い手には何も送っていない。人間に再送を頼むか、id を確かめること。',
    };
  }

  try {
    validateAttachmentBatch(metas.map(attachmentBatchItemOf), limits);
  } catch (error) {
    if (error instanceof AttachmentRejectedError) {
      return { ok: false, message: `${reasonOf(error)}。担い手には何も送っていない。` };
    }
    throw error;
  }

  // 大きいファイル（外部ストレージの別枠。合計に数えない）は、base64 で命令の本文に載せる今の下り口に載らない。
  // 黙って落とさず、断る（担い手へ下ろすのは #4128 段3）
  const large = metas.filter((meta) => isLargeAttachment(attachmentBatchItemOf(meta), limits));
  if (large.length > 0) {
    return {
      ok: false,
      message:
        `大きいファイルは担い手へまだ下ろせない（#4128 段3）: ` +
        `${large.map((meta) => `${meta.id}（${meta.name}, ${meta.size} バイト）`).join(', ')}。` +
        `${limits.maxFileBytes} バイトまでのファイルなら下ろせる。担い手には何も送っていない。`,
    };
  }

  const attachments: RunnerAttachment[] = [];
  for (const meta of metas) {
    let found;
    try {
      found = await stores.attachments.get(meta.id);
    } catch (error) {
      return { ok: false, message: `添付 ${meta.id} の中身を読めなかった: ${reasonOf(error)}` };
    }
    if (found === undefined) {
      return {
        ok: false,
        message: `添付 ${meta.id} は読む間に消えた（保持期限）。担い手には何も送っていない。`,
      };
    }
    attachments.push({
      id: meta.id,
      name: meta.name,
      mediaType: meta.mediaType,
      size: meta.size,
      sha256: meta.sha256,
      data: Buffer.from(found.bytes).toString('base64'),
    });
  }
  return { ok: true, attachments };
}

/**
 * 添付つきの命令の本文（JSON）の大きさの見積もり（バイト）。base64 の `data` と、名前・メタデータ・本文・
 * 封筒の余裕を足す。runner が名乗る上限（`hello.attachmentBodyLimit`）との比較に使う。
 */
export function estimateAttachmentBodyBytes(
  attachments: readonly RunnerAttachment[],
  text: string,
): number {
  const items = attachments.reduce(
    (sum, item) => sum + item.data.length + Buffer.byteLength(item.name) * 2 + 256,
    0,
  );
  return items + Buffer.byteLength(text) * 2 + 1024;
}

/** 送る前の検めで、添付を送らずに断ったこと（道具がエラー文にして返す）。 */
export class ManagerAttachmentsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerAttachmentsRefusedError';
  }
}

/** 日誌に残す参照（メタデータだけ。**中身（`data`）は落とす**）。 */
export function attachmentRefsOf(attachments: readonly RunnerAttachment[]): AttachmentRef[] {
  return attachments.map((item) => ({
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    size: item.size,
    sha256: item.sha256,
  }));
}
