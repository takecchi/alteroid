import { describe, expect, it } from 'vitest';

import { checkAttachments, type AttachmentCheckLimits } from './attachments.js';

const LIMITS: AttachmentCheckLimits = {
  maxImageBytes: 10,
  maxFileBytes: 100,
  maxLargeFileBytes: 1000,
  maxPerMessage: 3,
  maxTotalBytes: 150,
};

const file = (name: string, size: number, type = 'application/octet-stream') => ({
  name,
  size,
  type,
});

describe('checkAttachments: 大きいファイルの別枠（#4128 段2）', () => {
  it('画像以外は別枠まで通り、超えれば断る。画像は別枠の恩恵を受けない', () => {
    const { accepted, rejected } = checkAttachments(
      [],
      [file('a.bin', 1000), file('b.bin', 1001), file('c.png', 11, 'image/png')],
      LIMITS,
    );
    expect(accepted.map((f) => f.name)).toEqual(['a.bin']);
    expect(rejected.map((r) => r.name)).toEqual(['b.bin', 'c.png']);
  });

  it('大きいファイルは合計に数えず、個数には数える', () => {
    const { accepted, rejected } = checkAttachments(
      [],
      [file('big.bin', 900), file('a.bin', 100), file('b.bin', 50), file('c.bin', 1)],
      LIMITS,
    );
    expect(accepted.map((f) => f.name)).toEqual(['big.bin', 'a.bin', 'b.bin']);
    expect(rejected.map((r) => r.name)).toEqual(['c.bin']);
    expect(rejected[0]!.reason).toContain('3 個まで');
  });

  it('すでに添えたものの大きいファイルも合計に数えない', () => {
    const { accepted } = checkAttachments([file('big.bin', 900)], [file('a.bin', 100)], LIMITS);
    expect(accepted).toHaveLength(1);
  });

  it('maxLargeFileBytes を名乗らない（旧い）サーバの上限では、今までどおり maxFileBytes まで', () => {
    const old: AttachmentCheckLimits = {
      maxImageBytes: LIMITS.maxImageBytes,
      maxFileBytes: LIMITS.maxFileBytes,
      maxPerMessage: LIMITS.maxPerMessage,
      maxTotalBytes: LIMITS.maxTotalBytes,
    };
    const { accepted, rejected } = checkAttachments(
      [],
      [file('a.bin', 100), file('b.bin', 101)],
      old,
    );
    expect(accepted.map((f) => f.name)).toEqual(['a.bin']);
    expect(rejected.map((r) => r.name)).toEqual(['b.bin']);
  });
});
