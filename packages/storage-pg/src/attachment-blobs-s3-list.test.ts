import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { S3AttachmentBlobStore } from './attachment-blobs-s3.js';

// 資格はダミー値だけ。本物のバケットにも MinIO にも繋がない（S3Client は mock が受ける）
const CONFIG = {
  bucket: 'test-bucket',
  endpoint: 'https://s3.invalid',
  region: 'auto',
  accessKeyId: 'AKIADUMMY',
  secretAccessKey: 'dummy-secret',
  prefix: '',
  forcePathStyle: true,
} as const;

const s3 = mockClient(S3Client);

beforeEach(() => {
  s3.reset();
});
afterEach(() => {
  s3.reset();
});

async function collect(iter: AsyncIterable<{ key: string; lastModified: Date }>) {
  const out: { key: string; lastModified: Date }[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('S3AttachmentBlobStore.list（#4314）', () => {
  const t1 = new Date('2026-01-01T00:00:00Z');
  const t2 = new Date('2026-01-02T00:00:00Z');
  const t3 = new Date('2026-01-03T00:00:00Z');

  it('ContinuationToken でページを全部回り、bucket と prefix が渡る', async () => {
    s3.on(ListObjectsV2Command)
      .resolvesOnce({
        IsTruncated: true,
        NextContinuationToken: 'tok1',
        Contents: [{ Key: 'p/attachments/a', LastModified: t1 }],
      })
      .resolvesOnce({
        IsTruncated: true,
        NextContinuationToken: 'tok2',
        Contents: [{ Key: 'p/attachments/b', LastModified: t2 }],
      })
      .resolvesOnce({
        IsTruncated: false,
        Contents: [{ Key: 'p/attachments/c', LastModified: t3 }],
      });
    const items = await collect(new S3AttachmentBlobStore(CONFIG).list('p/attachments/'));
    expect(items).toEqual([
      { key: 'p/attachments/a', lastModified: t1 },
      { key: 'p/attachments/b', lastModified: t2 },
      { key: 'p/attachments/c', lastModified: t3 },
    ]);
    const calls = s3.commandCalls(ListObjectsV2Command);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.args[0].input.ContinuationToken)).toEqual([
      undefined,
      'tok1',
      'tok2',
    ]);
    for (const call of calls) {
      expect(call.args[0].input.Bucket).toBe('test-bucket');
      expect(call.args[0].input.Prefix).toBe('p/attachments/');
    }
  });

  it('LastModified の無い要素（と Key の無い要素）は列挙から外す', async () => {
    s3.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'attachments/a', LastModified: t1 },
        { Key: 'attachments/no-time' },
        { LastModified: t2 },
      ],
    });
    const items = await collect(new S3AttachmentBlobStore(CONFIG).list('attachments/'));
    expect(items).toEqual([{ key: 'attachments/a', lastModified: t1 }]);
  });

  it('Contents が無い（空の）ページでも終わる', async () => {
    s3.on(ListObjectsV2Command).resolves({ IsTruncated: false });
    expect(await collect(new S3AttachmentBlobStore(CONFIG).list('attachments/'))).toEqual([]);
  });

  it('列挙が落ちたら投げる', async () => {
    s3.on(ListObjectsV2Command).rejects(new Error('boom'));
    await expect(collect(new S3AttachmentBlobStore(CONFIG).list('attachments/'))).rejects.toThrow(
      'boom',
    );
  });
});
