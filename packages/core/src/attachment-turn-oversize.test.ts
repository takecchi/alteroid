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
