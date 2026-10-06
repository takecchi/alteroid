import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_IMAGE_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_OTHER_MAX_BYTES,
  attachmentMediaType,
  checkAttachments,
  isImageMediaType,
} from './attachments.js';

const file = (name: string, size: number, type = 'text/plain') => ({ name, size, type });

describe('checkAttachments', () => {
  it('上限ちょうどは通し、1バイト超えは理由つきで断る（画像 5 MiB / その他 25 MiB）', () => {
    const { accepted, rejected } = checkAttachments(
      [],
      [
        file('a.png', ATTACHMENT_IMAGE_MAX_BYTES, 'image/png'),
        file('b.png', ATTACHMENT_IMAGE_MAX_BYTES + 1, 'image/png'),
        file('c.pdf', ATTACHMENT_OTHER_MAX_BYTES, 'application/pdf'),
        file('d.pdf', ATTACHMENT_OTHER_MAX_BYTES + 1, 'application/pdf'),
      ],
    );
    expect(accepted.map((f) => f.name)).toEqual(['a.png', 'c.pdf']);
    expect(rejected.map((r) => r.name)).toEqual(['b.png', 'd.pdf']);
    expect(rejected[0]?.reason).toContain('画像は 1 つ 5.0 MB まで');
    expect(rejected[1]?.reason).toContain('ファイルは 1 つ 25.0 MB まで');
  });

  it('個数は 10 個まで（すでに添えた分も数える）', () => {
    const existing = Array.from({ length: ATTACHMENT_MAX_COUNT - 1 }, (_, i) => file(`e${i}`, 1));
    const { accepted, rejected } = checkAttachments(existing, [file('x', 1), file('y', 1)]);
    expect(accepted.map((f) => f.name)).toEqual(['x']);
    expect(rejected).toEqual([{ name: 'y', reason: '1回に添えられるのは 10 個まで' }]);
  });

  it('合計は 50 MiB まで', () => {
    const big = ATTACHMENT_OTHER_MAX_BYTES;
    const { accepted, rejected } = checkAttachments(
      [file('e', big)],
      [file('a', big), file('b', 1)],
    );
    expect(accepted.map((f) => f.name)).toEqual(['a']);
    expect(rejected[0]?.reason).toBe('合計は 50.0 MB まで');
  });

  it('空のファイルは断る', () => {
    expect(checkAttachments([], [file('z', 0)]).rejected[0]?.reason).toContain('空');
  });
});

describe('型の判定', () => {
  it('画像は4種だけ。型が空なら octet-stream', () => {
    expect(isImageMediaType('IMAGE/PNG')).toBe(true);
    expect(isImageMediaType('image/svg+xml')).toBe(false);
    expect(attachmentMediaType({ type: '' })).toBe('application/octet-stream');
    expect(attachmentMediaType({ type: 'text/csv' })).toBe('text/csv');
  });
});
