import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_S3_BUCKET_ENV,
  MemoryAttachmentBlobStore,
  attachmentBlobKey,
  readAttachmentBlobConfig,
} from './attachment-blob.js';
import {
  ATTACHMENT_MAX_LARGE_FILE_BYTES_DEFAULT,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentMaxBytes,
  planAttachmentStream,
  readAttachmentLimits,
  validateAttachmentBatch,
  validateAttachmentInput,
  type AttachmentLimits,
} from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { loadManagerAttachments } from './manager-attachments.js';

const MIB = 1024 * 1024;

const S3_ENV = {
  ALTEROID_ATTACHMENT_S3_BUCKET: 'bkt',
  ALTEROID_ATTACHMENT_S3_ACCESS_KEY_ID: 'AKIA-dummy',
  ALTEROID_ATTACHMENT_S3_SECRET_ACCESS_KEY: 'dummy-secret',
};

const LIMITS: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxImageBytes: 10,
  maxFileBytes: 100,
  maxLargeFileBytes: 1000,
  maxPerMessage: 3,
  maxTotalBytes: 150,
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AttachmentRejectedError) return error.code;
    throw error;
  }
  return undefined;
}

describe('readAttachmentBlobConfig（外部ストレージの設定）', () => {
  it('BUCKET が空・未設定なら off', () => {
    expect(readAttachmentBlobConfig({})).toEqual({ kind: 'off' });
    expect(readAttachmentBlobConfig({ [ATTACHMENT_S3_BUCKET_ENV]: '  ' })).toEqual({
      kind: 'off',
    });
  });

  it('鍵がそろえば on。region の既定は auto、prefix は / 終わりに正規化する', () => {
    const got = readAttachmentBlobConfig({
      ...S3_ENV,
      ALTEROID_ATTACHMENT_S3_PREFIX: '/team/a',
      ALTEROID_ATTACHMENT_S3_FORCE_PATH_STYLE: 'true',
      ALTEROID_ATTACHMENT_S3_ENDPOINT: 'https://s3.example.com',
    });
    expect(got).toEqual({
      kind: 'on',
      config: {
        bucket: 'bkt',
        endpoint: 'https://s3.example.com',
        region: 'auto',
        accessKeyId: 'AKIA-dummy',
        secretAccessKey: 'dummy-secret',
        prefix: 'team/a/',
        forcePathStyle: true,
      },
    });
    const bare = readAttachmentBlobConfig(S3_ENV);
    expect(bare).toMatchObject({ kind: 'on', config: { prefix: '', forcePathStyle: false } });
    expect(bare.kind === 'on' && bare.config.endpoint).toBeUndefined();
  });

  it('鍵が欠けていれば invalid。理由には名前だけを載せ、値は載せない', () => {
    const got = readAttachmentBlobConfig({
      ALTEROID_ATTACHMENT_S3_BUCKET: 'secret-bucket-name',
      ALTEROID_ATTACHMENT_S3_ACCESS_KEY_ID: 'AKIA-visible-value',
    });
    expect(got.kind).toBe('invalid');
    const reason = got.kind === 'invalid' ? got.reason : '';
    expect(reason).toContain('ALTEROID_ATTACHMENT_S3_SECRET_ACCESS_KEY');
    expect(reason).not.toContain('secret-bucket-name');
    expect(reason).not.toContain('AKIA-visible-value');
  });

  it('endpoint は https だけ。http は ALLOW_HTTP=1 のときだけ。不正な URL は invalid（値は載せない）', () => {
    const base = { ...S3_ENV };
    expect(
      readAttachmentBlobConfig({ ...base, ALTEROID_ATTACHMENT_S3_ENDPOINT: 'http://minio:9000' })
        .kind,
    ).toBe('invalid');
    expect(
      readAttachmentBlobConfig({
        ...base,
        ALTEROID_ATTACHMENT_S3_ENDPOINT: 'http://minio:9000',
        ALTEROID_ATTACHMENT_S3_ALLOW_HTTP: '1',
      }).kind,
    ).toBe('on');
    const bad = readAttachmentBlobConfig({
      ...base,
      ALTEROID_ATTACHMENT_S3_ENDPOINT: 'not a url with-token-xyz',
    });
    expect(bad.kind).toBe('invalid');
    expect(bad.kind === 'invalid' && bad.reason).not.toContain('with-token-xyz');
    expect(
      readAttachmentBlobConfig({ ...base, ALTEROID_ATTACHMENT_S3_ENDPOINT: 'ftp://x' }).kind,
    ).toBe('invalid');
  });
});

describe('attachmentBlobKey と MemoryAttachmentBlobStore', () => {
  it('key は attachments/<id>。prefix があれば前に付く', () => {
    expect(attachmentBlobKey('abc')).toBe('attachments/abc');
    expect(attachmentBlobKey('abc', 'p/')).toBe('p/attachments/abc');
  });

  it('put / open / remove（無い key は黙って成功）', async () => {
    const blobs = new MemoryAttachmentBlobStore();
    async function* body() {
      yield Uint8Array.from([1, 2]);
      yield Uint8Array.from([3]);
    }
    await blobs.put('k', body());
    const chunks: Buffer[] = [];
    for await (const chunk of (await blobs.open('k'))!) chunks.push(chunk as Buffer);
    expect([...Buffer.concat(chunks)]).toEqual([1, 2, 3]);
    expect(await blobs.open('none')).toBeUndefined();
    await blobs.remove(['k', 'none']);
    expect(await blobs.open('k')).toBeUndefined();
  });
});

describe('readAttachmentLimits の maxLargeFileBytes', () => {
  it('外部ストレージが無効なら 0（env を置いても効かない）', () => {
    const off = readAttachmentLimits({ ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES: '999999999' });
    expect(off.limits.maxLargeFileBytes).toBe(0);
    expect(DEFAULT_ATTACHMENT_LIMITS.maxLargeFileBytes).toBe(0);
  });

  it('設定が不正でも 0（有効と見なさない）', () => {
    const got = readAttachmentLimits({
      ALTEROID_ATTACHMENT_S3_BUCKET: 'bkt',
      ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES: '5',
    });
    expect(got.limits.maxLargeFileBytes).toBe(0);
  });

  it('有効なら既定 2 GiB。env で変えられ、不正値は警告して既定へ倒す', () => {
    expect(readAttachmentLimits(S3_ENV).limits.maxLargeFileBytes).toBe(2147483648);
    expect(ATTACHMENT_MAX_LARGE_FILE_BYTES_DEFAULT).toBe(2147483648);
    expect(
      readAttachmentLimits({ ...S3_ENV, ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES: '4096' }).limits
        .maxLargeFileBytes,
    ).toBe(4096);
    const bad = readAttachmentLimits({
      ...S3_ENV,
      ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES: 'abc',
    });
    expect(bad.limits.maxLargeFileBytes).toBe(2147483648);
    expect(bad.notes.join('\n')).toContain('ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES');
  });
});

describe('1つの上限（attachmentMaxBytes）', () => {
  it('画像は maxImageBytes、画像以外は maxLargeFileBytes が有効なら大きいほう、無効なら maxFileBytes', () => {
    expect(attachmentMaxBytes(LIMITS, true)).toBe(10);
    expect(attachmentMaxBytes(LIMITS, false)).toBe(1000);
    expect(attachmentMaxBytes({ ...LIMITS, maxLargeFileBytes: 0 }, false)).toBe(100);
    // 別枠が maxFileBytes より小さくても、下がらない
    expect(attachmentMaxBytes({ ...LIMITS, maxLargeFileBytes: 50 }, false)).toBe(100);
  });

  it('validateAttachmentInput: 画像以外は別枠まで通り、超えると too_large。画像は別枠の恩恵を受けない', () => {
    const file = (n: number) => ({
      name: 'a.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(n),
    });
    expect(codeOf(() => validateAttachmentInput(file(1000), LIMITS))).toBeUndefined();
    expect(codeOf(() => validateAttachmentInput(file(1001), LIMITS))).toBe('too_large');
    const png = new Uint8Array(11);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      codeOf(() =>
        validateAttachmentInput({ name: 'a.png', mediaType: 'image/png', bytes: png }, LIMITS),
      ),
    ).toBe('too_large');
  });

  it('planAttachmentStream も同じ上限を返す', () => {
    const plan = (mediaType: string, limits: AttachmentLimits) =>
      planAttachmentStream({ name: 'x', mediaType }, limits).max;
    expect(plan('video/mp4', LIMITS)).toBe(1000);
    expect(plan('video/mp4', { ...LIMITS, maxLargeFileBytes: 0 })).toBe(100);
    expect(plan('image/png', LIMITS)).toBe(10);
  });
});

describe('validateAttachmentBatch: 大きいファイルは合計に数えない（個数には数える）', () => {
  const file = (size: number) => ({ size, image: false });
  const image = (size: number) => ({ size, image: true });

  it('maxFileBytes を超える画像以外は、合計に入らない', () => {
    // 合計の上限 150。大きいもの（500）は数えず、100 + 50 = 150 は通る
    expect(codeOf(() => validateAttachmentBatch([file(500), file(100), file(50)], LIMITS))).toBe(
      undefined,
    );
    expect(codeOf(() => validateAttachmentBatch([file(500), file(100), file(51)], LIMITS))).toBe(
      'total_too_large',
    );
  });

  it('個数には数える', () => {
    expect(
      codeOf(() => validateAttachmentBatch([file(500), file(500), file(500), file(1)], LIMITS)),
    ).toBe('too_many');
  });

  it('maxFileBytes ちょうどは大きいファイルではなく、合計に数える。画像は常に数える', () => {
    expect(codeOf(() => validateAttachmentBatch([file(100), file(51)], LIMITS))).toBe(
      'total_too_large',
    );
    expect(
      codeOf(() =>
        validateAttachmentBatch([image(10), image(10), image(10)], {
          ...LIMITS,
          maxTotalBytes: 25,
        }),
      ),
    ).toBe('total_too_large');
  });
});

describe('大きいファイルは担い手へまだ下ろせない（#4128 段3）', () => {
  it('loadManagerAttachments は黙って落とさず、理由つきで断る', async () => {
    const stores = { attachments: new MemoryAttachmentStore({ limits: LIMITS }) };
    const big = await stores.attachments.put({
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(500),
    });
    const small = await stores.attachments.put({
      name: 'small.bin',
      mediaType: 'application/octet-stream',
      bytes: new Uint8Array(5),
    });
    const refused = await loadManagerAttachments(stores, [big.id, small.id], LIMITS);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain('大きいファイルは担い手へまだ下ろせない');
      expect(refused.message).toContain('#4128');
      expect(refused.message).toContain(big.id);
      expect(refused.message).not.toContain(small.id);
      expect(refused.message).toContain('何も送っていない');
    }
    const ok = await loadManagerAttachments(stores, [small.id], LIMITS);
    expect(ok.ok).toBe(true);
  });
});

describe('MIB の確認', () => {
  it('2 GiB は 2048 MiB', () => {
    expect(ATTACHMENT_MAX_LARGE_FILE_BYTES_DEFAULT).toBe(2048 * MIB);
  });
});
