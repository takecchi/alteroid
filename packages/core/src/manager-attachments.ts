import {
  AttachmentRejectedError,
  validateAttachmentBatch,
  type AttachmentLimits,
  type AttachmentStore,
} from './attachment.js';
import { reasonOf } from './dropped-record.js';
import type { RunnerAttachment } from './runner-protocol.js';
import type { AttachmentRef } from './schema.js';

// 断るときは例外ではなく `ok: false` と文を返す: 呼び手の道具がそのまま本文にする。中身は読むだけで、記憶・日誌には写さない。
export type LoadedManagerAttachments =
  | { readonly ok: true; readonly attachments: RunnerAttachment[] }
  | { readonly ok: false; readonly message: string };

export async function loadManagerAttachments(
  stores: { readonly attachments: AttachmentStore },
  ids: readonly string[],
  limits: AttachmentLimits,
): Promise<LoadedManagerAttachments> {
  // 置き場の dir が id なので、同じ id を重ねても得るものが無い。
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
    validateAttachmentBatch(
      metas.map((meta) => meta.size),
      limits,
    );
  } catch (error) {
    if (error instanceof AttachmentRejectedError) {
      return { ok: false, message: `${reasonOf(error)}。担い手には何も送っていない。` };
    }
    throw error;
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
