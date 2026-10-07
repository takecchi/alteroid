import { describe, expect, it } from 'vitest';

import {
  attachmentTooLargeMessage,
  attachmentTooManyMessage,
  attachmentTotalTooLargeMessage,
  describeAttachmentActual,
  formatAttachmentLimit,
} from './attachment-wording.js';

const MIB = 1024 * 1024;

describe('添付の断りの文（#3933）', () => {
  it('上限は MiB で割り切れれば MiB、そうでなければ小数1桁（1 MiB 未満は B）', () => {
    expect(formatAttachmentLimit(5 * MIB)).toBe('5 MiB');
    expect(formatAttachmentLimit(1536 * 1024)).toBe('1.5 MiB');
    expect(formatAttachmentLimit(2048)).toBe('2.0 KiB');
    expect(formatAttachmentLimit(1000)).toBe('1000 B');
  });

  it('実際の大きさは人が読める単位で言う', () => {
    expect(describeAttachmentActual(6 * MIB, 5 * MIB)).toBe('6.0 MiB ある');
    expect(describeAttachmentActual(5 * MIB + 200 * 1024, 5 * MIB)).toBe('5.2 MiB ある');
    expect(describeAttachmentActual(1001, 1000)).toBe('1001 B ある');
  });

  it('丸めると上限と同じに見える値は、バイトを添える（境界: 1バイト超え・丸めの端）', () => {
    expect(describeAttachmentActual(5 * MIB + 1, 5 * MIB)).toBe('5,242,881 バイトある');
    // 5.05 MiB 未満は 5.0 に丸まる
    expect(describeAttachmentActual(5 * MIB + 52_428, 5 * MIB)).toBe('5,295,308 バイトある');
    // 5.05 MiB ちょうど付近から 5.1 になり、バイトは要らない
    expect(describeAttachmentActual(5 * MIB + 52_429, 5 * MIB)).toBe('5.1 MiB ある');
  });

  it('文の形（画像・ファイル・個数・合計）', () => {
    expect(attachmentTooLargeMessage('image', 5 * MIB + 1, 5 * MIB)).toBe(
      '画像は 1 つ 5 MiB まで（5,242,881 バイトある）',
    );
    expect(attachmentTooLargeMessage('image', 6 * MIB, 5 * MIB)).toBe(
      '画像は 1 つ 5 MiB まで（6.0 MiB ある）',
    );
    expect(attachmentTooLargeMessage('file', 26 * MIB, 25 * MIB)).toBe(
      'ファイルは 1 つ 25 MiB まで（26.0 MiB ある）',
    );
    expect(attachmentTooManyMessage(10, 11)).toBe('1 発言に添えられるのは 10 個まで（11 個）');
    expect(attachmentTotalTooLargeMessage(50 * MIB, 50 * MIB + 1)).toBe(
      '1 発言の合計は 50 MiB まで（52,428,801 バイトある）',
    );
    expect(attachmentTotalTooLargeMessage(50 * MIB, 60 * MIB)).toBe(
      '1 発言の合計は 50 MiB まで（60.0 MiB ある）',
    );
  });
});
