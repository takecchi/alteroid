import type { AttachmentImageMediaType } from './attachment.js';

// API の上限（幅・高さそれぞれ 8000px）: https://platform.claude.com/docs/en/build-with-claude/vision
export const ATTACHMENT_MAX_IMAGE_DIMENSION = 8000;

export interface AttachmentImageSize {
  readonly width: number;
  readonly height: number;
}

// 壊れた入力で長く回らないための上限
const JPEG_MAX_SEGMENTS = 2048;
const JPEG_MAX_SCAN_BYTES = 4 * 1024 * 1024;

const u16be = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u16le = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number): number =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, o: number): number =>
  (b[o] ?? 0) * 0x1000000 + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
const u32le = (b: Uint8Array, o: number): number =>
  (b[o] ?? 0) + (b[o + 1] ?? 0) * 0x100 + (b[o + 2] ?? 0) * 0x10000 + (b[o + 3] ?? 0) * 0x1000000;

const tagAt = (b: Uint8Array, o: number, tag: string): boolean =>
  b.length >= o + tag.length && [...tag].every((c, i) => b[o + i] === c.charCodeAt(0));

function pngSize(b: Uint8Array): AttachmentImageSize | undefined {
  if (b.length < 24 || !tagAt(b, 12, 'IHDR')) return undefined;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gifSize(b: Uint8Array): AttachmentImageSize | undefined {
  if (b.length < 10) return undefined;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function webpSize(b: Uint8Array): AttachmentImageSize | undefined {
  if (tagAt(b, 12, 'VP8X')) {
    if (b.length < 30) return undefined;
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (tagAt(b, 12, 'VP8L')) {
    if (b.length < 25 || b[20] !== 0x2f) return undefined;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: (Math.floor(bits / 0x4000) & 0x3fff) + 1 };
  }
  if (tagAt(b, 12, 'VP8 ')) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return undefined;
}

function jpegSize(b: Uint8Array): AttachmentImageSize | undefined {
  const end = Math.min(b.length, JPEG_MAX_SCAN_BYTES);
  let i = 2;
  for (let segments = 0; segments < JPEG_MAX_SEGMENTS; segments += 1) {
    while (i < end && b[i] !== 0xff) i += 1;
    while (i < end && b[i] === 0xff) i += 1;
    if (i >= end) return undefined;
    const marker = b[i] ?? 0;
    i += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (i + 2 > end) return undefined;
    const length = u16be(b, i);
    if (length < 2) return undefined;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 7 || i + 7 > b.length) return undefined;
      return { width: u16be(b, i + 5), height: u16be(b, i + 3) };
    }
    i += length;
  }
  return undefined;
}

/** 画像の寸法を中身のヘッダから読む。読めなければ `undefined`。 */
export function readAttachmentImageSize(
  bytes: Uint8Array,
  mediaType: AttachmentImageMediaType,
): AttachmentImageSize | undefined {
  const size =
    mediaType === 'image/png'
      ? pngSize(bytes)
      : mediaType === 'image/jpeg'
        ? jpegSize(bytes)
        : mediaType === 'image/gif'
          ? gifSize(bytes)
          : webpSize(bytes);
  if (size === undefined || size.width <= 0 || size.height <= 0) return undefined;
  return size;
}

/** 寸法が API の上限を超えるか。寸法が読めないときは `false`（断れる根拠が無いため）。 */
export function isImageOverDimension(
  bytes: Uint8Array,
  mediaType: AttachmentImageMediaType,
): boolean {
  const size = readAttachmentImageSize(bytes, mediaType);
  return (
    size !== undefined &&
    (size.width > ATTACHMENT_MAX_IMAGE_DIMENSION || size.height > ATTACHMENT_MAX_IMAGE_DIMENSION)
  );
}

export function imageDimensionOverNotice(openHint: string): string {
  return `（画像の寸法の上限（${ATTACHMENT_MAX_IMAGE_DIMENSION}x${ATTACHMENT_MAX_IMAGE_DIMENSION} px）を超えるので画像としては渡していない。${openHint}）`;
}
