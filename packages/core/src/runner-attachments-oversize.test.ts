import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { DEFAULT_ATTACHMENT_LIMITS } from './attachment.js';
import { composeAttachmentInput, placeRunnerAttachments } from './runner-attachments.js';

function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function attachmentOf(bytes: Uint8Array) {
  return {
    id: 'att-1',
    name: 'x.bin',
    mediaType: 'application/octet-stream',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: Buffer.from(bytes).toString('base64'),
  };
}

describe('composeAttachmentInput: 画像の上限を超える中身は画像として渡さない（#3325）', () => {
  it('octet-stream の 6 MiB の PNG は images に入らず、通知行が理由を言う（既定の上限）', async () => {
    const root = await makeTempDir('oversize-');
    const placed = await placeRunnerAttachments({
      root,
      managerId: 'mgr-1',
      attachments: [attachmentOf(pngOfSize(6 * 1024 * 1024))],
    });
    const input = composeAttachmentInput('依頼', placed);
    expect(input.images).toBeUndefined();
    expect(input.text).toContain('画像の上限（5 MiB）を超えるので画像としては渡していない');
    expect(input.text).toContain('path で Read で開ける');
    expect(input.text).not.toContain('画像としても渡した');
  });

  it('渡された limits で決まる。上限ちょうどは画像、上限+1 は画像にしない', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 1000 };
    const root = await makeTempDir('oversize-');
    const exact = await placeRunnerAttachments({
      root,
      managerId: 'mgr-1',
      attachments: [attachmentOf(pngOfSize(1000))],
      limits,
    });
    expect(composeAttachmentInput('t', exact).images).toHaveLength(1);
    const over = await placeRunnerAttachments({
      root,
      managerId: 'mgr-2',
      attachments: [attachmentOf(pngOfSize(1001))],
      limits,
    });
    const input = composeAttachmentInput('t', over);
    expect(input.images).toBeUndefined();
    expect(input.text).toContain('画像の上限（1000 B）を超える');
  });
});
