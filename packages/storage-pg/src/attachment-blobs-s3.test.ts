import { Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
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
const MIB = 1024 * 1024;

beforeEach(() => {
  s3.reset();
});
afterEach(() => {
  s3.reset();
});

async function* parts(sizes: number[]): AsyncGenerator<Uint8Array> {
  for (const size of sizes) yield new Uint8Array(size).fill(7);
}

async function drain(stream: Readable): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(out);
}

describe('S3AttachmentBlobStore', () => {
  it('put: 小さいものは PutObject 1回。bucket と key と中身が渡る', async () => {
    s3.on(PutObjectCommand).resolves({});
    await new S3AttachmentBlobStore(CONFIG).put('p/attachments/abc', parts([3, 2]));
    const calls = s3.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.Bucket).toBe('test-bucket');
    expect(input.Key).toBe('p/attachments/abc');
    // 小さいものは lib-storage が1つの Buffer にして送る
    expect(Buffer.from(input.Body as Uint8Array)).toEqual(Buffer.alloc(5, 7));
  });

  it('put: 大きいものは multipart（長さが分からないストリームを分けて送り、最後に Complete）', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(UploadPartCommand).resolves({ ETag: '"e"' });
    s3.on(CompleteMultipartUploadCommand).resolves({});
    await new S3AttachmentBlobStore(CONFIG).put('k', parts([6 * MIB, 6 * MIB, 1]));
    expect(s3.commandCalls(CreateMultipartUploadCommand)).toHaveLength(1);
    expect(s3.commandCalls(UploadPartCommand).length).toBeGreaterThanOrEqual(2);
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('put: part の大きさは置き場が受けうる最大から決める（10,000 part で届く大きさ。省けば 5 MiB。#4128）', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(UploadPartCommand).resolves({ ETag: '"e"' });
    s3.on(CompleteMultipartUploadCommand).resolves({});
    const partSizesOf = async (store: S3AttachmentBlobStore): Promise<number[]> => {
      s3.resetHistory();
      await store.put('k', parts([25 * MIB]));
      return s3
        .commandCalls(UploadPartCommand)
        .map((call) => (call.args[0].input.Body as Uint8Array).byteLength);
    };

    const maxObjectBytes = 100 * 1024 * MIB;
    const wide = await partSizesOf(new S3AttachmentBlobStore(CONFIG, { maxObjectBytes }));
    const partBytes = Math.ceil(maxObjectBytes / 10_000);
    expect(partBytes).toBeGreaterThan(5 * MIB);
    expect(wide.slice(0, -1).every((size) => size === partBytes)).toBe(true);
    expect(wide.reduce((a, b) => a + b, 0)).toBe(25 * MIB);

    const narrow = await partSizesOf(new S3AttachmentBlobStore(CONFIG));
    expect(narrow.slice(0, -1).every((size) => size === 5 * MIB)).toBe(true);
  });

  it('put: 本文が途中で投げたら、投げ直し、multipart は Abort して Complete しない', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(UploadPartCommand).resolves({ ETag: '"e"' });
    s3.on(AbortMultipartUploadCommand).resolves({});
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(6 * MIB);
      yield new Uint8Array(6 * MIB);
      throw new Error('本文が投げた');
    }
    await expect(new S3AttachmentBlobStore(CONFIG).put('k', failing())).rejects.toThrow(
      '本文が投げた',
    );
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0);
    expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
  });

  it('open: Body を Readable で返す。NoSuchKey / 404 は undefined、それ以外は投げる', async () => {
    const store = new S3AttachmentBlobStore(CONFIG);
    // Node の実体では Body は IncomingMessage（Readable）。型だけ SDK の混ぜ物に合わせる
    s3.on(GetObjectCommand).resolves({
      Body: Readable.from([Buffer.from('hello')]) as never,
    });
    const stream = await store.open('k');
    expect((await drain(stream!)).toString()).toBe('hello');
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input).toMatchObject({
      Bucket: 'test-bucket',
      Key: 'k',
    });

    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: 'x', $metadata: {} }));
    expect(await store.open('k')).toBeUndefined();

    s3.on(GetObjectCommand).rejects(
      new S3ServiceException({
        name: 'Whatever',
        $fault: 'client',
        $metadata: { httpStatusCode: 404 },
        message: 'x',
      }),
    );
    expect(await store.open('k')).toBeUndefined();

    s3.on(GetObjectCommand).rejects(
      new S3ServiceException({
        name: 'AccessDenied',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
        message: 'denied',
      }),
    );
    await expect(store.open('k')).rejects.toThrow('denied');
  });

  it('remove: 1000 件ずつ DeleteObjects。空なら呼ばない', async () => {
    s3.on(DeleteObjectsCommand).resolves({});
    const store = new S3AttachmentBlobStore(CONFIG);
    await store.remove([]);
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    const keys = Array.from({ length: 2500 }, (_, i) => `attachments/${i}`);
    await store.remove(keys);
    const calls = s3.commandCalls(DeleteObjectsCommand);
    expect(calls.map((call) => call.args[0].input.Delete?.Objects?.length)).toEqual([
      1000, 1000, 500,
    ]);
    expect(calls[0]!.args[0].input.Bucket).toBe('test-bucket');
  });

  it('remove: 削除を断られたら投げる。文に key を載せない', async () => {
    s3.on(DeleteObjectsCommand).resolves({
      Errors: [{ Key: 'attachments/secret-id', Code: 'AccessDenied', Message: 'no' }],
    });
    const failure = await new S3AttachmentBlobStore(CONFIG).remove(['attachments/secret-id']).then(
      () => new Error('投げなかった'),
      (error: unknown) => error as Error,
    );
    expect(failure.message).toContain('AccessDenied');
    expect(failure.message).not.toContain('secret-id');
  });
});
