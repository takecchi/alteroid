import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  ATTACHMENT_MAX_IMAGE_DIMENSION,
  isImageOverDimension,
  readAttachmentImageSize,
} from './attachment-image-size.js';
import { resolveTurnAttachmentGroups, resolveTurnAttachments } from './attachment-turn.js';
import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentImageMediaType } from './attachment.js';
import { composeAttachmentInput, placeRunnerAttachments } from './runner-attachments.js';
import { createMemoryStores } from './testing.js';

const MAX = ATTACHMENT_MAX_IMAGE_DIMENSION;
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** ヘッダだけの小さなバイト列。形式ごとに寸法を載せる。 */
const png = (w: number, h: number) =>
  Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
  ]);
const gif = (w: number, h: number) =>
  Uint8Array.from([...ascii('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0]);
const jpeg = (w: number, h: number) =>
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    ...ascii('JFIF'),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    ...be16(11),
    8,
    ...be16(h),
    ...be16(w),
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ]);
const webpHead = (chunk: string) => [
  ...ascii('RIFF'),
  0,
  0,
  0,
  0,
  ...ascii('WEBP'),
  ...ascii(chunk),
  0,
  0,
  0,
  0,
];
const webpX = (w: number, h: number) =>
  Uint8Array.from([...webpHead('VP8X'), 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = (w: number, h: number) => {
  const bits = w - 1 + (h - 1) * 0x4000;
  return Uint8Array.from([
    ...webpHead('VP8L'),
    0x2f,
    bits & 0xff,
    Math.floor(bits / 0x100) & 0xff,
    Math.floor(bits / 0x10000) & 0xff,
    Math.floor(bits / 0x1000000) & 0xff,
  ]);
};
const webpLossy = (w: number, h: number) =>
  Uint8Array.from([...webpHead('VP8 '), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);

const FORMATS: readonly [string, AttachmentImageMediaType, (w: number, h: number) => Uint8Array][] =
  [
    ['png', 'image/png', png],
    ['jpeg', 'image/jpeg', jpeg],
    ['gif', 'image/gif', gif],
    ['webp(VP8X)', 'image/webp', webpX],
    ['webp(VP8L)', 'image/webp', webpL],
    ['webp(VP8)', 'image/webp', webpLossy],
  ];

const DIM_NOTICE =
  '画像の寸法の上限（8000x8000 px）を超えるので画像としては渡していない。attachment_fetch で取り出して Read で開ける';

describe('readAttachmentImageSize（#3697）', () => {
  for (const [name, type, make] of FORMATS) {
    it(`${name}: 幅と高さを読む`, () => {
      expect(readAttachmentImageSize(make(123, 4567), type)).toEqual({ width: 123, height: 4567 });
    });
    it(`${name}: 切れたヘッダは undefined（落ちない）`, () => {
      const full = make(100, 100);
      for (let n = 0; n < full.length; n += 1) {
        expect(() => readAttachmentImageSize(full.subarray(0, n), type)).not.toThrow();
      }
      expect(readAttachmentImageSize(full.subarray(0, 9), type)).toBeUndefined();
    });
  }

  it('jpeg: 寸法が 0・長さが壊れた・SOF が無いものは undefined', () => {
    expect(readAttachmentImageSize(jpeg(0, 10), 'image/jpeg')).toBeUndefined();
    expect(
      readAttachmentImageSize(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 1, 2, 3]),
        'image/jpeg',
      ),
    ).toBeUndefined();
    expect(
      readAttachmentImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), 'image/jpeg'),
    ).toBeUndefined();
  });

  it('jpeg: 走査は有界。0xFF だらけ・長さ 2 のセグメントの連続でも有限時間で undefined', () => {
    const fill = new Uint8Array(1024 * 1024).fill(0xff);
    fill.set([0xff, 0xd8]);
    expect(readAttachmentImageSize(fill, 'image/jpeg')).toBeUndefined();
    const tiny = new Uint8Array(2 + 4 * 100000);
    tiny.set([0xff, 0xd8]);
    for (let i = 2; i < tiny.length; i += 4) tiny.set([0xff, 0xe1, 0, 2], i);
    expect(readAttachmentImageSize(tiny, 'image/jpeg')).toBeUndefined();
  });

  it('壊れた png（IHDR でない）・空は undefined', () => {
    const broken = png(10, 10);
    broken.set(ascii('XXXX'), 12);
    expect(readAttachmentImageSize(broken, 'image/png')).toBeUndefined();
    expect(readAttachmentImageSize(new Uint8Array(0), 'image/png')).toBeUndefined();
    expect(readAttachmentImageSize(new Uint8Array(0), 'image/jpeg')).toBeUndefined();
  });
});

describe('resolveTurnAttachments: 寸法が上限を超える画像は画像として渡さない（#3697）', () => {
  // 画像の宣言では上げる時点で断られる（#3697）ので、ターンの受け皿が受け止める3つのうち「宣言が画像以外」の形で預ける。
  async function put(
    stores: ReturnType<typeof createMemoryStores>,
    name: string,
    bytes: Uint8Array,
  ) {
    return stores.attachments.put({ name, mediaType: 'application/octet-stream', bytes });
  }

  for (const [name, , make] of FORMATS) {
    it(`${name}: 8000px ちょうどは画像、幅 8001 も高さ 8001 も外れて通知行が理由と開け方を言う`, async () => {
      const stores = createMemoryStores();
      const ok = await put(stores, 'ok', make(MAX, MAX));
      const wide = await put(stores, 'wide', make(MAX + 1, 10));
      const tall = await put(stores, 'tall', make(10, MAX + 1));
      const out = await resolveTurnAttachments(stores, [ok, wide, tall]);
      expect(out.images.map((i) => i.name)).toEqual(['ok']);
      expect(out.noticeLines[0]).toContain('（画像として渡した）');
      for (const line of out.noticeLines.slice(1)) {
        expect(line).toContain(DIM_NOTICE);
        expect(line).not.toContain('（画像として渡した）');
      }
    });
  }

  it('読めない寸法（壊れたヘッダ）は今までどおり画像として渡す', async () => {
    const stores = createMemoryStores();
    const broken = await put(stores, 'broken', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    const cut = await put(stores, 'cut', png(MAX + 1, 1).subarray(0, 20));
    const out = await resolveTurnAttachments(stores, [broken, cut]);
    expect(out.images.map((i) => i.name)).toEqual(['broken', 'cut']);
  });

  it('1枚の大きさの上限（#3325）が先。両方に当たる画像は大きさの理由で言う', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 30 };
    const stores = createMemoryStores();
    const big = await stores.attachments.put({
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      bytes: Uint8Array.from([...png(MAX + 1, 1), ...new Array<number>(20).fill(0)]),
    });
    const out = await resolveTurnAttachments(stores, [big], limits);
    expect(out.noticeLines[0]).toContain('画像の上限（30 B）を超えるので画像としては渡していない');
    expect(out.noticeLines[0]).not.toContain('寸法');
  });

  it('寸法が先でターンの予算より前。寸法で外した画像は予算を使わず、理由も寸法', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImages: 1 };
    const stores = createMemoryStores();
    const huge = await put(stores, 'huge.png', png(MAX + 1, 1));
    const a = await put(stores, 'a.png', png(10, 10));
    const b = await put(stores, 'b.png', png(10, 10));
    const out = await resolveTurnAttachments(stores, [huge, a, b], limits);
    expect(out.images.map((i) => i.name)).toEqual(['a.png']);
    expect(out.noticeLines[0]).toContain(DIM_NOTICE);
    expect(out.noticeLines[0]).not.toContain('このターンの画像');
    expect(out.noticeLines[2]).toContain('このターンの画像は上限（1 枚）まで');

    const groups = await resolveTurnAttachmentGroups(stores, [[a], [huge]], limits);
    expect(groups[0]?.images.map((i) => i.name)).toEqual(['a.png']);
    expect(groups[1]?.images).toHaveLength(0);
  });
});

describe('placeRunnerAttachments: 寸法が上限を超える画像は画像として渡さない（#3697）', () => {
  const attachmentOf = (id: string, bytes: Uint8Array) => ({
    id,
    name: `${id}.bin`,
    mediaType: 'application/octet-stream',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: Buffer.from(bytes).toString('base64'),
  });

  for (const [name, , make] of FORMATS) {
    it(`${name}: 8000px ちょうどは画像、8001px は外れて通知行が path での開け方を言う`, async () => {
      const root = await makeTempDir('dim-');
      const placed = await placeRunnerAttachments({
        root,
        managerId: 'mgr-1',
        attachments: [
          attachmentOf('ok', make(MAX, MAX)),
          attachmentOf('wide', make(MAX + 1, 5)),
          attachmentOf('tall', make(5, MAX + 1)),
        ],
      });
      const input = composeAttachmentInput('依頼', placed);
      expect(input.images).toHaveLength(1);
      const lines = input.text.split('\n').filter((l) => l.startsWith('[添付]'));
      expect(lines[0]).toContain('（画像としても渡した）');
      for (const line of lines.slice(1)) {
        expect(line).toContain(
          '画像の寸法の上限（8000x8000 px）を超えるので画像としては渡していない。path で Read で開ける',
        );
      }
    });
  }

  it('寸法で外した画像はターンの予算を使わない。読めない寸法は画像として渡す', async () => {
    const root = await makeTempDir('dim-');
    const placed = await placeRunnerAttachments({
      root,
      managerId: 'mgr-1',
      attachments: [
        attachmentOf('huge', png(MAX + 1, 1)),
        attachmentOf('a', png(10, 10)),
        attachmentOf('b', png(10, 10)),
        attachmentOf('cut', png(MAX + 1, 1).subarray(0, 20)),
      ],
      limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImages: 2 },
    });
    expect(placed.map((p) => p.image !== undefined)).toEqual([false, true, true, false]);
    expect(placed[0]?.imageOverDimension).toBe(true);
    // 枠は a と b で埋まり、cut（寸法は読めないが画像）は枚数の理由で外れる。
    expect(placed[3]?.imageOverTurnLimit?.reason).toBe('count');
  });

  it('isImageOverDimension は読めなければ false', () => {
    expect(isImageOverDimension(new Uint8Array(3), 'image/png')).toBe(false);
  });
});
