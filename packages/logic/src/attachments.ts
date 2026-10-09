// 上限の数字はサーバの契約（`apps/daemon/openapi.json`）の写し: 最終的な判定はサーバで、ここは送る前に断るだけ。
// 値は `@alteroid/core` 本体でなく軽い口から取る: 本体はサーバ専用の層ごとバンドルへ入る。
import {
  attachmentMaxBytes,
  attachmentTooLargeMessage,
  attachmentTooManyMessage,
  attachmentTotalTooLargeMessage,
  isLargeAttachmentSize,
} from '@alteroid/core/attachment-wording';
import type { AttachmentLimits } from './types.js';

const MIB = 1024 * 1024;

export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * MIB;
export const ATTACHMENT_OTHER_MAX_BYTES = 25 * MIB;
export const ATTACHMENT_MAX_COUNT = 10;
export const ATTACHMENT_TOTAL_MAX_BYTES = 50 * MIB;

// `maxLargeFileBytes` は任せる（名乗らない旧いサーバの応答は 0＝枠なしとして読む）
export type AttachmentCheckLimits = Pick<
  AttachmentLimits,
  'maxImageBytes' | 'maxFileBytes' | 'maxPerMessage' | 'maxTotalBytes'
> &
  Partial<Pick<AttachmentLimits, 'maxLargeFileBytes'>>;

export const DEFAULT_ATTACHMENT_CHECK_LIMITS: AttachmentCheckLimits = {
  maxImageBytes: ATTACHMENT_IMAGE_MAX_BYTES,
  maxFileBytes: ATTACHMENT_OTHER_MAX_BYTES,
  maxPerMessage: ATTACHMENT_MAX_COUNT,
  maxTotalBytes: ATTACHMENT_TOTAL_MAX_BYTES,
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isImageMediaType(mediaType: string): boolean {
  return IMAGE_TYPES.has(mediaType.toLowerCase());
}

// サーバの画像の4種に揃える: svg など他の型は画像として描かない。
export const isPreviewableImage = isImageMediaType;

// 型を言わないファイルは、サーバの既定に合わせて octet-stream とする。
export function attachmentMediaType(file: { type: string }): string {
  return file.type === '' ? 'application/octet-stream' : file.type;
}

interface Sized {
  name: string;
  size: number;
  type: string;
}

export function checkAttachments<T extends Sized>(
  existing: readonly Sized[],
  incoming: readonly T[],
  given?: AttachmentCheckLimits | null,
): { accepted: T[]; rejected: { name: string; reason: string }[] } {
  const limits = given ?? DEFAULT_ATTACHMENT_CHECK_LIMITS;
  const accepted: T[] = [];
  const rejected: { name: string; reason: string }[] = [];
  let count = existing.length;
  // 大きいファイル（画像以外で maxFileBytes を超えるもの）は合計に数えない（個数には数える）
  const counted = (item: Sized): number =>
    isLargeAttachmentSize(limits, item.size, isImageMediaType(item.type)) ? 0 : item.size;
  let total = existing.reduce((sum, item) => sum + counted(item), 0);
  for (const file of incoming) {
    const image = isImageMediaType(file.type);
    const limit = attachmentMaxBytes(limits, image);
    let reason: string | undefined;
    if (count >= limits.maxPerMessage) {
      reason = attachmentTooManyMessage(limits.maxPerMessage, count + 1);
    } else if (file.size === 0) {
      reason = '空のファイルは添えられない';
    } else if (file.size > limit) {
      reason = attachmentTooLargeMessage(image ? 'image' : 'file', file.size, limit);
    } else if (total + counted(file) > limits.maxTotalBytes) {
      reason = attachmentTotalTooLargeMessage(limits.maxTotalBytes, total + counted(file));
    }
    if (reason === undefined) {
      accepted.push(file);
      count += 1;
      total += counted(file);
    } else {
      rejected.push({ name: file.name, reason });
    }
  }
  return { accepted, rejected };
}
