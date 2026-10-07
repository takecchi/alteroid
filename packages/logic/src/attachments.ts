// 上限の数字はサーバの契約（`apps/daemon/openapi.json`）の写し: 最終的な判定はサーバで、ここは送る前に断るだけ。
import { formatBytes } from './format.js';
import type { AttachmentLimits } from './types.js';

const MIB = 1024 * 1024;

export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * MIB;
export const ATTACHMENT_OTHER_MAX_BYTES = 25 * MIB;
export const ATTACHMENT_MAX_COUNT = 10;
export const ATTACHMENT_TOTAL_MAX_BYTES = 50 * MIB;

export type AttachmentCheckLimits = Pick<
  AttachmentLimits,
  'maxImageBytes' | 'maxFileBytes' | 'maxPerMessage' | 'maxTotalBytes'
>;

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
  let total = existing.reduce((sum, item) => sum + item.size, 0);
  for (const file of incoming) {
    const image = isImageMediaType(file.type);
    const limit = image ? limits.maxImageBytes : limits.maxFileBytes;
    let reason: string | undefined;
    if (count >= limits.maxPerMessage) {
      reason = `1回に添えられるのは ${limits.maxPerMessage} 個まで`;
    } else if (file.size === 0) {
      reason = '空のファイルは添えられない';
    } else if (file.size > limit) {
      reason = `${image ? '画像' : 'ファイル'}は 1 つ ${formatBytes(limit)} まで（${formatBytes(file.size)} ある）`;
    } else if (total + file.size > limits.maxTotalBytes) {
      reason = `合計は ${formatBytes(limits.maxTotalBytes)} まで`;
    }
    if (reason === undefined) {
      accepted.push(file);
      count += 1;
      total += file.size;
    } else {
      rejected.push({ name: file.name, reason });
    }
  }
  return { accepted, rejected };
}
