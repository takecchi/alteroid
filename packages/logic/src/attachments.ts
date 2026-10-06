/**
 * 添付（Issue #3111 段1c）の、クライアント側の先行検査と表示の判定。
 *
 * **最終的な判定はサーバである**（`POST /attachments` が 413 / 400 で返す）。ここは
 * 「送る前に分かる言葉で断る」ためだけの写しで、上限の数字はサーバの契約
 * （`apps/daemon/openapi.json` の `POST /attachments` と `POST /chat`）に合わせてある。
 */
import { formatBytes } from './format.js';

const MIB = 1024 * 1024;

/** 画像（png / jpeg / webp / gif）1つの上限。 */
export const ATTACHMENT_IMAGE_MAX_BYTES = 5 * MIB;
/** 画像以外1つの上限。 */
export const ATTACHMENT_OTHER_MAX_BYTES = 25 * MIB;
/** 1発言に添えられる個数。 */
export const ATTACHMENT_MAX_COUNT = 10;
/** 1発言の合計。 */
export const ATTACHMENT_TOTAL_MAX_BYTES = 50 * MIB;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** サーバが画像として扱う型か（上限が小さい側）。 */
export function isImageMediaType(mediaType: string): boolean {
  return IMAGE_TYPES.has(mediaType.toLowerCase());
}

/** 縮小表示してよい型か。サーバの画像の4種に揃える（svg など他の型は画像として描かない）。 */
export const isPreviewableImage = isImageMediaType;

/** ブラウザが型を言わないファイル（拡張子が未知）は、サーバの既定に合わせて octet-stream とする。 */
export function attachmentMediaType(file: { type: string }): string {
  return file.type === '' ? 'application/octet-stream' : file.type;
}

interface Sized {
  name: string;
  size: number;
  type: string;
}

/**
 * すでに添えたもの（`existing`）へ `incoming` を足してよいかを順に検査する。
 * 通ったものを `accepted`、断ったものを理由つきで `rejected` に返す（通ったものだけ足せばよい）。
 */
export function checkAttachments<T extends Sized>(
  existing: readonly Sized[],
  incoming: readonly T[],
): { accepted: T[]; rejected: { name: string; reason: string }[] } {
  const accepted: T[] = [];
  const rejected: { name: string; reason: string }[] = [];
  let count = existing.length;
  let total = existing.reduce((sum, item) => sum + item.size, 0);
  for (const file of incoming) {
    const image = isImageMediaType(file.type);
    const limit = image ? ATTACHMENT_IMAGE_MAX_BYTES : ATTACHMENT_OTHER_MAX_BYTES;
    let reason: string | undefined;
    if (count >= ATTACHMENT_MAX_COUNT) {
      reason = `1回に添えられるのは ${ATTACHMENT_MAX_COUNT} 個まで`;
    } else if (file.size === 0) {
      reason = '空のファイルは添えられない';
    } else if (file.size > limit) {
      reason = `${image ? '画像' : 'ファイル'}は 1 つ ${formatBytes(limit)} まで（${formatBytes(file.size)} ある）`;
    } else if (total + file.size > ATTACHMENT_TOTAL_MAX_BYTES) {
      reason = `合計は ${formatBytes(ATTACHMENT_TOTAL_MAX_BYTES)} まで`;
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
