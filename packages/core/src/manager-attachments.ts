import {
  AttachmentRejectedError,
  attachmentBatchItemOf,
  isLargeAttachment,
  validateAttachmentBatch,
  type AttachmentLimits,
  type AttachmentStore,
} from './attachment.js';
import { reasonOf } from './dropped-record.js';
import type { RunnerAttachment, RunnerStagedAttachmentMeta } from './runner-protocol.js';
import type { AttachmentRef } from './schema.js';

// 断るときは例外ではなく `ok: false` と文を返す: 呼び手の道具がそのまま本文にする。中身は読むだけで、記憶・日誌には写さない。
/** 大きいファイル（別口で置いてから参照するもの。#4128 段3a）。`attachments` の該当要素は `staged: true` で、中身は読んでいない。 */
export interface StagedManagerAttachment {
  readonly meta: RunnerStagedAttachmentMeta;
}

export type LoadedManagerAttachments =
  | {
      readonly ok: true;
      readonly attachments: RunnerAttachment[];
      readonly staged: readonly StagedManagerAttachment[];
    }
  | { readonly ok: false; readonly message: string };

export async function loadManagerAttachments(
  stores: { readonly attachments: AttachmentStore },
  ids: readonly string[],
  limits: AttachmentLimits,
): Promise<LoadedManagerAttachments> {
  // 置き場の dir が id なので、同じ id を重ねても得るものが無い。
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, attachments: [], staged: [] };

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

  // 大きいファイル（外部ストレージの別枠。合計に数えない）は命令の本文に載せない。中身は読まず、
  // 送る側（`ManagerPool`）が runner の別口へストリームで押してから、命令では `staged: true` で参照する（#4128 段3a）。
  const attachments: RunnerAttachment[] = [];
  const staged: StagedManagerAttachment[] = [];
  for (const meta of metas) {
    if (isLargeAttachment(attachmentBatchItemOf(meta), limits)) {
      const ref = {
        id: meta.id,
        name: meta.name,
        mediaType: meta.mediaType,
        size: meta.size,
        sha256: meta.sha256,
      };
      staged.push({ meta: ref });
      attachments.push({ ...ref, staged: true });
      continue;
    }
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
  return { ok: true, attachments, staged };
}

export function estimateAttachmentBodyBytes(
  attachments: readonly RunnerAttachment[],
  text: string,
): number {
  const items = attachments.reduce(
    // `staged`（別口で置く）は中身を載せないので 0 と数える。
    (sum, item) => sum + (item.data?.length ?? 0) + Buffer.byteLength(item.name) * 2 + 256,
    0,
  );
  return items + Buffer.byteLength(text) * 2 + 1024;
}

export class ManagerAttachmentsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagerAttachmentsRefusedError';
  }
}

export function attachmentRefsOf(attachments: readonly RunnerAttachment[]): AttachmentRef[] {
  return attachments.map((item) => ({
    id: item.id,
    name: item.name,
    mediaType: item.mediaType,
    size: item.size,
    sha256: item.sha256,
  }));
}
