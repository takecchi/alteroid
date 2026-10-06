import { describe, expect, it } from 'vitest';

import { resolveTurnAttachmentGroups, resolveTurnAttachments } from './attachment-turn.js';
import { DEFAULT_ATTACHMENT_LIMITS, readAttachmentLimits } from './attachment.js';
import { createMemoryStores } from './testing.js';

/** 先頭が PNG のマジックで、`size` バイトになる中身。 */
function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

type Stores = ReturnType<typeof createMemoryStores>;

async function putPng(stores: Stores, name: string, size: number) {
  return stores.attachments.put({ name, mediaType: 'image/png', bytes: pngOfSize(size) });
}

const COUNT_NOTICE =
  '（このターンの画像は上限（2 枚）までで、これは超えた分なので画像としては渡していない。attachment_fetch で取り出して Read で開ける）';

describe('ターンの画像の枚数の上限（#3696）', () => {
  const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImages: 2 };

  it('上限ちょうどの枚数はすべて画像、1枚超えると最後の1枚が画像にならず、通知行は添付の順に出る', async () => {
    const stores = createMemoryStores();
    const a = await putPng(stores, 'a.png', 20);
    const b = await putPng(stores, 'b.png', 20);
    const c = await putPng(stores, 'c.png', 20);
    const exact = await resolveTurnAttachments(stores, [a, b], limits);
    expect(exact.images.map((i) => i.name)).toEqual(['a.png', 'b.png']);

    const over = await resolveTurnAttachments(stores, [a, b, c], limits);
    expect(over.images.map((i) => i.name)).toEqual(['a.png', 'b.png']);
    expect(over.noticeLines).toHaveLength(3);
    expect(over.noticeLines[0]).toContain('name=a.png');
    expect(over.noticeLines[1]).toContain('name=b.png');
    expect(over.noticeLines[2]).toContain('name=c.png');
    expect(over.noticeLines[2]).toContain(COUNT_NOTICE);
    expect(over.noticeLines[0]).toContain('（画像として渡した）');
  });

  it('新しい発言から数える。古い発言の画像から外れ、通知行は発言ごとに残る', async () => {
    const stores = createMemoryStores();
    const old = await putPng(stores, 'old.png', 20);
    const mid = await putPng(stores, 'mid.png', 20);
    const recent = await putPng(stores, 'recent.png', 20);
    const out = await resolveTurnAttachmentGroups(stores, [[old], [mid], [recent]], limits);
    expect(out.map((g) => g.images.map((i) => i.name))).toEqual([[], ['mid.png'], ['recent.png']]);
    expect(out[0]?.noticeLines).toHaveLength(1);
    expect(out[0]?.noticeLines[0]).toContain('name=old.png');
    expect(out[0]?.noticeLines[0]).toContain(COUNT_NOTICE);
  });

  it('同じ発言の中は後ろの画像から外れる（新しい発言が先に枠を使う）', async () => {
    const stores = createMemoryStores();
    const older = await putPng(stores, 'older.png', 20);
    const x1 = await putPng(stores, 'x1.png', 20);
    const x2 = await putPng(stores, 'x2.png', 20);
    const x3 = await putPng(stores, 'x3.png', 20);
    const out = await resolveTurnAttachmentGroups(stores, [[older], [x1, x2, x3]], limits);
    expect(out[1]?.images.map((i) => i.name)).toEqual(['x1.png', 'x2.png']);
    expect(out[1]?.noticeLines[2]).toContain(COUNT_NOTICE);
    expect(out[0]?.images).toHaveLength(0);
    expect(out[0]?.noticeLines[0]).toContain(COUNT_NOTICE);
  });
});

describe('ターンの画像の合計バイトの上限（#3696）', () => {
  const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImageBytes: 1000 };
  const TOTAL_NOTICE =
    '（このターンの画像の合計の上限（1000 B）を超えるので画像としては渡していない。attachment_fetch で取り出して Read で開ける）';

  it('合計が上限ちょうどならすべて画像、1バイト超えると後ろの画像が外れる', async () => {
    const stores = createMemoryStores();
    const a = await putPng(stores, 'a.png', 600);
    const b = await putPng(stores, 'b.png', 400);
    const b2 = await putPng(stores, 'b2.png', 401);
    const exact = await resolveTurnAttachments(stores, [a, b], limits);
    expect(exact.images).toHaveLength(2);
    const over = await resolveTurnAttachments(stores, [a, b2], limits);
    expect(over.images.map((i) => i.name)).toEqual(['a.png']);
    expect(over.noticeLines[1]).toContain('name=b2.png');
    expect(over.noticeLines[1]).toContain(TOTAL_NOTICE);
  });

  it('古い発言の画像から外れる', async () => {
    const stores = createMemoryStores();
    const old = await putPng(stores, 'old.png', 600);
    const recent = await putPng(stores, 'recent.png', 600);
    const out = await resolveTurnAttachmentGroups(stores, [[old], [recent]], limits);
    expect(out[0]?.images).toHaveLength(0);
    expect(out[0]?.noticeLines[0]).toContain(TOTAL_NOTICE);
    expect(out[1]?.images.map((i) => i.name)).toEqual(['recent.png']);
  });

  it('外れたものは枠を使わない。あとの小さい画像は枠に残りがあれば入る', async () => {
    const stores = createMemoryStores();
    const big = await putPng(stores, 'big.png', 900);
    const huge = await putPng(stores, 'huge.png', 500);
    const small = await putPng(stores, 'small.png', 100);
    const out = await resolveTurnAttachments(stores, [big, huge, small], limits);
    expect(out.images.map((i) => i.name)).toEqual(['big.png', 'small.png']);
    expect(out.noticeLines[1]).toContain(TOTAL_NOTICE);
  });
});

describe('1枚の上限（#3325）とターンの予算の両方', () => {
  it('1枚の上限で外した画像は予算を使わず、通知行は1枚の上限の文言のまま', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 100, maxTurnImages: 1 };
    const stores = createMemoryStores();
    const tooBig = await stores.attachments.put({
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      bytes: pngOfSize(101),
    });
    const ok1 = await putPng(stores, 'ok1.png', 50);
    const ok2 = await putPng(stores, 'ok2.png', 50);
    const out = await resolveTurnAttachments(stores, [tooBig, ok1, ok2], limits);
    expect(out.images.map((i) => i.name)).toEqual(['ok1.png']);
    expect(out.noticeLines[0]).toContain('画像の上限（100 B）を超えるので画像としては渡していない');
    expect(out.noticeLines[0]).not.toContain('このターンの画像');
    expect(out.noticeLines[2]).toContain('このターンの画像は上限（1 枚）まで');
  });

  it('枚数と合計の両方を超える画像は、枚数の理由で言う', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImages: 1, maxTurnImageBytes: 10 };
    const stores = createMemoryStores();
    const a = await putPng(stores, 'a.png', 10);
    const b = await putPng(stores, 'b.png', 10);
    const out = await resolveTurnAttachments(stores, [a, b], limits);
    expect(out.images).toHaveLength(1);
    expect(out.noticeLines[1]).toContain('このターンの画像は上限（1 枚）まで');
  });
});

describe('環境変数で上限が変わる（#3696）', () => {
  it('readAttachmentLimits の値がそのまま予算になる', async () => {
    const { limits } = readAttachmentLimits({
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGES: '1',
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES: '5000',
    });
    const stores = createMemoryStores();
    const a = await putPng(stores, 'a.png', 20);
    const b = await putPng(stores, 'b.png', 20);
    const out = await resolveTurnAttachments(stores, [a, b], limits);
    expect(out.images).toHaveLength(1);
    expect(out.noticeLines[1]).toContain('上限（1 枚）');
  });

  it('既定は 20 枚。21 枚目から外れる', async () => {
    const stores = createMemoryStores();
    const refs = [];
    for (let i = 0; i < 21; i += 1) refs.push(await putPng(stores, `p${i}.png`, 10));
    const out = await resolveTurnAttachments(stores, refs, DEFAULT_ATTACHMENT_LIMITS);
    expect(out.images).toHaveLength(20);
    expect(out.noticeLines[20]).toContain('このターンの画像は上限（20 枚）まで');
  });
});
