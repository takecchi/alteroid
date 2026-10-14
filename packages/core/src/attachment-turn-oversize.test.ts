import { describe, expect, it } from 'vitest';

import { resolveTurnAttachments } from './attachment-turn.js';
import { DEFAULT_ATTACHMENT_LIMITS } from './attachment.js';
import { createMemoryStores } from './testing.js';

function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

async function putOctet(bytes: Uint8Array) {
  const stores = createMemoryStores();
  const meta = await stores.attachments.put({
    name: 'x.bin',
    mediaType: 'application/octet-stream',
    bytes,
  });
  return { stores, meta };
}

describe('resolveTurnAttachments: 画像の上限を超える中身は画像として渡さない（#3325）', () => {
  it('宣言が octet-stream の 6 MiB の PNG は images に入らず、通知行が理由と開け方を言う', async () => {
    const { stores, meta } = await putOctet(pngOfSize(6 * 1024 * 1024));
    const out = await resolveTurnAttachments(stores, [meta]);
    expect(out.images).toHaveLength(0);
    expect(out.noticeLines).toHaveLength(1);
    expect(out.noticeLines[0]).toContain('画像の上限（5 MiB）を超えるので画像としては渡していない');
    expect(out.noticeLines[0]).toContain('attachment_fetch');
    expect(out.noticeLines[0]).not.toContain('（画像として渡した）');
  });

  it('渡された limits で決まる。上限ちょうどは画像、上限+1 は画像にしない', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 1000 };
    const exact = await putOctet(pngOfSize(1000));
    const okOut = await resolveTurnAttachments(exact.stores, [exact.meta], limits);
    expect(okOut.images).toHaveLength(1);
    expect(okOut.noticeLines[0]).toContain('（画像として渡した）');

    const over = await putOctet(pngOfSize(1001));
    const ngOut = await resolveTurnAttachments(over.stores, [over.meta], limits);
    expect(ngOut.images).toHaveLength(0);
    expect(ngOut.noticeLines[0]).toContain('画像の上限（1000 B）を超える');
  });
});

describe('resolveTurnAttachments: 画像の上限を超える添付は全体を読まない（#4687）', () => {
  // `get()`（全体を読む口）の呼び出しを数える。`open()`（流し）は通す
  function counting(stores: ReturnType<typeof createMemoryStores>) {
    const counts = { get: 0, open: 0 };
    const base = stores.attachments;
    const attachments = new Proxy(base, {
      get(target, property) {
        if (property === 'get') {
          return async (id: string) => {
            counts.get += 1;
            return target.get(id);
          };
        }
        if (property === 'open') {
          return async (id: string) => {
            counts.open += 1;
            return target.open(id);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    return { stores: { attachments }, counts };
  }

  it.each([
    [
      '画像でない大きい添付',
      new Uint8Array(2000).fill(0x41),
      '（attachment_fetch で取り出して Read で開ける）',
    ],
    [
      '画像の大きい添付',
      pngOfSize(2000),
      '画像の上限（1000 B）を超えるので画像としては渡していない',
    ],
  ])(
    '⭐ %s は get で全体を読まず、先頭だけで見分けて同じ文言を出す',
    async (_name, bytes, sentence) => {
      const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 1000 };
      const put = await putOctet(bytes);
      const { stores, counts } = counting(put.stores);
      const out = await resolveTurnAttachments(stores, [put.meta], limits);
      expect(counts.get).toBe(0);
      expect(counts.open).toBe(1);
      expect(out.images).toHaveLength(0);
      expect(out.noticeLines).toHaveLength(1);
      expect(out.noticeLines[0]).toContain(sentence);
    },
  );

  it('画像の上限以下の添付は、今までどおり全体を読んで画像として渡す', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 1000 };
    const put = await putOctet(pngOfSize(500));
    const { stores, counts } = counting(put.stores);
    const out = await resolveTurnAttachments(stores, [put.meta], limits);
    expect(counts.get).toBe(1);
    expect(out.images).toHaveLength(1);
  });
});
