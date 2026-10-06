import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_RETENTION_DAYS_ENV,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  normalizeAttachmentName,
  readAttachmentLimits,
  sniffAttachmentImageType,
  validateAttachmentBatch,
  validateAttachmentInput,
} from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { verifyAttachmentStoreContract } from './attachment-contract.js';
import { createMemoryStores } from './testing.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat());

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AttachmentRejectedError ? error.code : `other:${String(error)}`;
  }
  return undefined;
}

describe('添付: マジックバイト', () => {
  it('png / jpeg / gif / webp を判定する', () => {
    expect(sniffAttachmentImageType(bytes(PNG))).toBe('image/png');
    expect(sniffAttachmentImageType(bytes(JPEG))).toBe('image/jpeg');
    expect(sniffAttachmentImageType(bytes(GIF))).toBe('image/gif');
    expect(sniffAttachmentImageType(bytes([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('image/gif');
    expect(sniffAttachmentImageType(bytes(WEBP))).toBe('image/webp');
  });

  it('どれでもなければ undefined（RIFF だけの WAV も webp にしない）', () => {
    expect(sniffAttachmentImageType(bytes([1, 2, 3]))).toBeUndefined();
    expect(sniffAttachmentImageType(new Uint8Array())).toBeUndefined();
    expect(
      sniffAttachmentImageType(bytes([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])),
    ).toBeUndefined();
  });

  it('宣言が画像なのに中身が一致しなければ拒否する', () => {
    const run = (mediaType: string, b: Uint8Array) =>
      codeOf(() => validateAttachmentInput({ name: 'x', mediaType, bytes: b }));
    expect(run('image/png', bytes(JPEG))).toBe('magic_mismatch');
    expect(run('image/webp', bytes([1, 2, 3]))).toBe('magic_mismatch');
    expect(run('image/png', bytes(PNG))).toBeUndefined();
    // 画像でない宣言は中身を問わない
    expect(run('application/pdf', bytes([1, 2, 3]))).toBeUndefined();
  });
});

describe('添付: 上限', () => {
  it('画像は 5 MiB、その他は 25 MiB まで', () => {
    const png = (n: number) => {
      const b = new Uint8Array(n);
      b.set(PNG);
      return b;
    };
    const run = (mediaType: string, b: Uint8Array) =>
      codeOf(() => validateAttachmentInput({ name: 'x', mediaType, bytes: b }));
    expect(run('image/png', png(5 * 1024 * 1024))).toBeUndefined();
    expect(run('image/png', png(5 * 1024 * 1024 + 1))).toBe('too_large');
    expect(run('video/mp4', new Uint8Array(25 * 1024 * 1024))).toBeUndefined();
    expect(run('video/mp4', new Uint8Array(25 * 1024 * 1024 + 1))).toBe('too_large');
  });

  it('1発言は 10 個・合計 50 MiB まで', () => {
    const mib = 1024 * 1024;
    expect(codeOf(() => validateAttachmentBatch(Array(10).fill(mib)))).toBeUndefined();
    expect(codeOf(() => validateAttachmentBatch(Array(11).fill(1)))).toBe('too_many');
    expect(codeOf(() => validateAttachmentBatch([25 * mib, 25 * mib]))).toBeUndefined();
    expect(codeOf(() => validateAttachmentBatch([25 * mib, 25 * mib, 1]))).toBe('total_too_large');
  });

  it('環境変数で変えられる。読めない値は notes に落として既定へ倒す', () => {
    const ok = readAttachmentLimits({ [ATTACHMENT_RETENTION_DAYS_ENV]: '7' });
    expect(ok.limits.retentionDays).toBe(7);
    expect(ok.limits.maxImageBytes).toBe(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes);
    expect(ok.notes).toEqual([]);
    const bad = readAttachmentLimits({ ALTEROID_ATTACHMENT_MAX_PER_MESSAGE: 'many' });
    expect(bad.limits.maxPerMessage).toBe(10);
    expect(bad.notes).toHaveLength(1);
  });
});

describe('添付: ファイル名', () => {
  it('NUL・パス区切り・孤立サロゲートを除く', () => {
    expect(normalizeAttachmentName('a\u0000b.txt')).toBe('ab.txt');
    expect(normalizeAttachmentName('../etc/passwd')).toBe('.._etc_passwd');
    expect(normalizeAttachmentName('C:\\x\\y.png')).toBe('C:_x_y.png');
    expect(normalizeAttachmentName('a\ud83d.txt')).toBe('a\ufffd.txt');
    expect(normalizeAttachmentName('..')).toBe('file');
    expect(normalizeAttachmentName('')).toBe('file');
    expect(normalizeAttachmentName('日本語.pdf')).toBe('日本語.pdf');
  });
});

describe('添付: インメモリ実装の契約', () => {
  it('verifyAttachmentStoreContract を通る', async () => {
    await verifyAttachmentStoreContract(createMemoryStores().attachments, {
      createStore: (options) => new MemoryAttachmentStore(options),
    });
  });
});
