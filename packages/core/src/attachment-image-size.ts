import type { AttachmentImageMediaType } from './attachment.js';

/**
 * 画像1枚の寸法の上限（幅・高さそれぞれ。px）。API の上限（#3697）:
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * 「The maximum dimensions per image are 8000x8000 px.」
 */
export const ATTACHMENT_MAX_IMAGE_DIMENSION = 8000;

export interface AttachmentImageSize {
  readonly width: number;
  readonly height: number;
}

/** jpeg の走査で辿るセグメント数の上限（壊れた入力で長く回らないため。普通の jpeg は数十個以内に SOF が来る）。 */
const JPEG_MAX_SEGMENTS = 2048;
/** jpeg の走査で見る先頭のバイト数の上限（SOF は先頭の方にある。大きな EXIF・ICC の後ろまでは届く値）。 */
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
  // 署名 8 + IHDR（長さ 4・"IHDR" 4・幅 4・高さ 4）
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
  let i = 2; // SOI（FF D8）の次
  for (let segments = 0; segments < JPEG_MAX_SEGMENTS; segments += 1) {
    // マーカーは 0xFF の後ろ。詰め物の 0xFF は読み飛ばす。
    while (i < end && b[i] !== 0xff) i += 1;
    while (i < end && b[i] === 0xff) i += 1;
    if (i >= end) return undefined;
    const marker = b[i] ?? 0;
    i += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // 長さの無いもの
    // EOI・SOS の後ろに SOF は来ない（あっても寸法は読めない扱い）。
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (i + 2 > end) return undefined;
    const length = u16be(b, i);
    if (length < 2) return undefined;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // 長さ 2・精度 1・高さ 2・幅 2
      if (length < 7 || i + 7 > b.length) return undefined;
      return { width: u16be(b, i + 5), height: u16be(b, i + 3) };
    }
    i += length;
  }
  return undefined;
}

/**
 * 画像の寸法を中身のヘッダから読む（png / jpeg / gif / webp。手書き。依存なし。#3697）。
 * **読めなければ `undefined`**（ヘッダが切れている・壊れている・対応外の形式・寸法が 0）。
 * 走査は有界（jpeg は {@link JPEG_MAX_SEGMENTS} セグメント・{@link JPEG_MAX_SCAN_BYTES} バイトまで）で、
 * 入力のコピーも作らない。
 */
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

/**
 * 寸法が API の上限（幅・高さのどちらかが {@link ATTACHMENT_MAX_IMAGE_DIMENSION} px 超）を超えるか。
 * **寸法が読めないときは `false`**（断れる根拠が無いので、今までどおり画像として渡す。API に断られる危険は残る）。
 */
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

/** 寸法で外した画像の通知行の末尾の括弧書き。`openHint` は開け方（クローンは attachment_fetch、担い手は path）。 */
export function imageDimensionOverNotice(openHint: string): string {
  return `（画像の寸法の上限（${ATTACHMENT_MAX_IMAGE_DIMENSION}x${ATTACHMENT_MAX_IMAGE_DIMENSION} px）を超えるので画像としては渡していない。${openHint}）`;
}
