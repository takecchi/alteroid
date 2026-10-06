import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { DEFAULT_ATTACHMENT_LIMITS, readAttachmentLimits } from './attachment.js';
import { composeAttachmentInput, placeRunnerAttachments } from './runner-attachments.js';

function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function attachmentOf(id: string, size: number) {
  const bytes = pngOfSize(size);
  return {
    id,
    name: `${id}.png`,
    mediaType: 'image/png',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: Buffer.from(bytes).toString('base64'),
  };
}

async function place(
  sizes: number[],
  limits: Parameters<typeof placeRunnerAttachments>[0]['limits'],
) {
  const root = await makeTempDir('budget-');
  return placeRunnerAttachments({
    root,
    managerId: 'mgr-1',
    attachments: sizes.map((size, i) => attachmentOf(`a${i}`, size)),
    ...(limits === undefined ? {} : { limits }),
  });
}

describe('placeRunnerAttachments: 1メッセージの画像の枚数・合計の予算（#3696）', () => {
  it('枚数: 上限ちょうどはすべて画像、1枚超えると最後の1枚は image なしで通知行が理由を言う', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImages: 2 };
    const exact = await place([20, 20], limits);
    expect(composeAttachmentInput('t', exact).images).toHaveLength(2);

    const over = await place([20, 20, 20], limits);
    expect(over.map((p) => p.image !== undefined)).toEqual([true, true, false]);
    expect(over[2]?.imageOverTurnLimit).toEqual({ reason: 'count', limit: 2 });
    const input = composeAttachmentInput('t', over);
    expect(input.images).toHaveLength(2);
    expect(input.text).toContain(
      '（このターンの画像は上限（2 枚）までで、これは超えた分なので画像としては渡していない。path で Read で開ける）',
    );
    expect(input.text.split('\n').filter((l) => l.startsWith('[添付]'))).toHaveLength(3);
  });

  it('合計: 上限ちょうどはすべて画像、1バイト超えると後ろの画像は image なし', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImageBytes: 1000 };
    const exact = await place([600, 400], limits);
    expect(composeAttachmentInput('t', exact).images).toHaveLength(2);

    const over = await place([600, 401], limits);
    expect(over.map((p) => p.image !== undefined)).toEqual([true, false]);
    expect(over[1]?.imageOverTurnLimit).toEqual({ reason: 'bytes', limit: 1000 });
    const input = composeAttachmentInput('t', over);
    expect(input.images).toHaveLength(1);
    expect(input.text).toContain(
      '（このターンの画像の合計の上限（1000 B）を超えるので画像としては渡していない。path で Read で開ける）',
    );
  });

  it('1枚の上限で外した画像は予算を使わず、通知行は1枚の上限の文言のまま', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 100, maxTurnImages: 1 };
    const placed = await place([101, 50, 50], limits);
    expect(placed.map((p) => p.image !== undefined)).toEqual([false, true, false]);
    expect(placed[0]?.imageOverLimit).toBe(100);
    expect(placed[0]?.imageOverTurnLimit).toBeUndefined();
    expect(placed[2]?.imageOverTurnLimit?.reason).toBe('count');
  });

  it('環境変数（readAttachmentLimits）の値で変わる', async () => {
    const { limits } = readAttachmentLimits({ ALTEROID_ATTACHMENT_MAX_TURN_IMAGES: '1' });
    const placed = await place([20, 20], limits);
    expect(placed.map((p) => p.image !== undefined)).toEqual([true, false]);
  });
});
