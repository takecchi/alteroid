import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_RETENTION_DAYS_DEFAULT,
  ATTACHMENT_RETENTION_DAYS_ENV,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentDiskName,
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

  it('ターンの画像の枚数・合計は既定 20 枚・16 MiB で、環境変数で変えられる（#3696）', () => {
    const defaults = readAttachmentLimits({});
    expect(defaults.limits.maxTurnImages).toBe(20);
    expect(defaults.limits.maxTurnImageBytes).toBe(16 * 1024 * 1024);
    expect(Object.keys(DEFAULT_ATTACHMENT_LIMITS)).not.toContain('maxTurnImages');
    const changed = readAttachmentLimits({
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGES: '5',
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES: '1000',
    });
    expect(changed.limits.maxTurnImages).toBe(5);
    expect(changed.limits.maxTurnImageBytes).toBe(1000);
    expect(changed.notes).toEqual([]);
    const bad = readAttachmentLimits({
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGES: '0',
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES: 'big',
    });
    expect(bad.limits.maxTurnImages).toBe(20);
    expect(bad.limits.maxTurnImageBytes).toBe(16 * 1024 * 1024);
    expect(bad.notes).toHaveLength(2);
  });

  it('保持日数は上限（36500 日）まで。超えたら notes に落として既定へ倒し、put が RangeError にならない（#3326）', async () => {
    const atMax = readAttachmentLimits({
      [ATTACHMENT_RETENTION_DAYS_ENV]: '36500',
    });
    expect(atMax.limits.retentionDays).toBe(36500);
    expect(atMax.notes).toEqual([]);
    const over = readAttachmentLimits({
      [ATTACHMENT_RETENTION_DAYS_ENV]: '36501',
    });
    expect(over.limits.retentionDays).toBe(ATTACHMENT_RETENTION_DAYS_DEFAULT);
    expect(over.notes).toHaveLength(1);
    expect(over.notes[0]).toContain(ATTACHMENT_RETENTION_DAYS_ENV);
    const huge = readAttachmentLimits({ [ATTACHMENT_RETENTION_DAYS_ENV]: '1000000000000000' });
    expect(huge.limits.retentionDays).toBe(ATTACHMENT_RETENTION_DAYS_DEFAULT);
    expect(huge.notes).toHaveLength(1);
    expect(
      readAttachmentLimits({ ALTEROID_ATTACHMENT_MAX_FILE_BYTES: '1000000000000' }).notes,
    ).toEqual([]);
    const store = new MemoryAttachmentStore({ limits: huge.limits });
    const meta = await store.put({ name: 'a', mediaType: 'text/plain', bytes: Uint8Array.of(1) });
    expect(Date.parse(meta.expiresAt)).toBeGreaterThan(Date.parse(meta.createdAt));
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

  it('書式制御文字（双方向制御など）と C1 制御文字を _ にする。通常の文字は残す（#3332）', () => {
    expect(normalizeAttachmentName('evil\u202Efdp.exe')).toBe('evil_fdp.exe');
    expect(normalizeAttachmentName('a\u200Eb\u200Fc\u2066d\u2069e\u200Bf\uFEFFg')).toBe(
      'a_b_c_d_e_f_g',
    );
    expect(normalizeAttachmentName('a\u0080b\u009Fc')).toBe('a_b_c');
    expect(normalizeAttachmentName('日本語\u00e9.pdf')).toBe('日本語\u00e9.pdf');
  });

  it('normalizeAttachmentName は冪等である: 255 単位で切った結果が空白で終わっても、もう一度通すと名前が変わらない（#3524）', () => {
    const once = normalizeAttachmentName(`${'a'.repeat(254)} b`);
    expect(normalizeAttachmentName(once)).toBe(once);
    expect(once).toBe('a'.repeat(254));
  });

  it('ディスク名: 200 バイトまでは触らず、超えたら拡張子を残してコードポイントの途中で切らずに丸める（#3324）', () => {
    expect(attachmentDiskName('日本語.pdf')).toBe('日本語.pdf');
    const long = attachmentDiskName(`${'あ'.repeat(100)}.pdf`);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(200);
    expect(long).toBe(`${'あ'.repeat(65)}.pdf`);
    const emoji = attachmentDiskName('😀'.repeat(100));
    expect(Buffer.byteLength(emoji, 'utf8')).toBeLessThanOrEqual(200);
    expect(emoji).toBe('😀'.repeat(50));
    expect(emoji).not.toContain('\ufffd');
    expect(
      Buffer.byteLength(attachmentDiskName(`a.${'b'.repeat(250)}`), 'utf8'),
    ).toBeLessThanOrEqual(200);
    expect(
      Buffer.byteLength(attachmentDiskName(`.${'b'.repeat(250)}`), 'utf8'),
    ).toBeLessThanOrEqual(200);
    expect(attachmentDiskName('')).toBe('file');
  });
});

describe('添付: インメモリ実装の契約', () => {
  it('verifyAttachmentStoreContract を通る', async () => {
    await verifyAttachmentStoreContract(createMemoryStores().attachments, {
      createStore: (options) => new MemoryAttachmentStore(options),
    });
  });
});

describe('添付: インメモリ実装は期限（expiresAt）を過ぎたものを読ませない（#3522）', () => {
  const PNG_BYTES = Uint8Array.from([...PNG, 7]);
  const DAY = 86_400_000;

  it('getMeta / get は、prune が走る前でも「無い」と答える', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new MemoryAttachmentStore({ now: () => now });
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG_BYTES });
    now = new Date(Date.parse(meta.expiresAt) + 1000);
    expect(await store.getMeta(meta.id)).toBeUndefined();
    expect(await store.get(meta.id)).toBeUndefined();
  });

  it('bind は missing にする（結んだ直後の prune で発言の添付が黙って消えるのを避ける）', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new MemoryAttachmentStore({ now: () => now });
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG_BYTES });
    now = new Date(Date.parse(meta.expiresAt) + DAY);
    const result = await store.bind([meta.id], 'conv-1');
    expect(result.bound).toEqual([]);
    expect(result.missing).toEqual([meta.id]);
  });
});
