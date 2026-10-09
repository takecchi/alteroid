import { Readable } from 'node:stream';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandOutput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { AttachmentBlobConfig, AttachmentBlobStore } from '@alteroid/core';

/** `DeleteObjects` は1回に 1000 件まで。 */
const DELETE_BATCH = 1000;

/**
 * 添付の中身の置き場の S3 互換の実装（#4128 段2）。S3 API で一般に書く（特定の事業者に寄せない）。
 * key は呼び手（`PgAttachmentStore`）が prefix 込みで渡す。ここでは足さない。
 *
 * 失敗の文に key・資格・endpoint の値を載せない（呼び手が stderr へ出す）。
 */
export class S3AttachmentBlobStore implements AttachmentBlobStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: AttachmentBlobConfig, client?: S3Client) {
    this.#bucket = config.bucket;
    this.#client = client ?? new S3Client(clientConfigOf(config));
  }

  /** 長さの分からないストリームを multipart で置く。途中で body が投げたら `Upload` が畳み、何も残らない。 */
  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const upload = new Upload({
      client: this.#client,
      params: {
        Bucket: this.#bucket,
        Key: key,
        Body: Readable.from(body, { objectMode: false }),
      },
    });
    await upload.done();
  }

  async open(key: string): Promise<Readable | undefined> {
    let response;
    try {
      response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return toReadable(response.Body);
  }

  /** `prefix` の下を `ContinuationToken` で全部回る。`LastModified` が無い要素は外す（判定できないものは消さない側へ倒す）。 */
  async *list(prefix: string): AsyncGenerator<{ key: string; lastModified: Date }> {
    let token: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: prefix,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key === undefined || item.LastModified === undefined) continue;
        yield { key: item.Key, lastModified: item.LastModified };
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const batch = keys.slice(start, start + DELETE_BATCH);
      const response = await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const errors = response.Errors ?? [];
      if (errors.length > 0) {
        // 無い key は成功として返る。ここへ来るのは権限・サーバの失敗（key は載せない）
        throw new Error(`${errors.length} 件の削除を断られた（code=${errors[0]?.Code ?? '不明'}）`);
      }
    }
  }
}

function clientConfigOf(config: AttachmentBlobConfig): S3ClientConfig {
  return {
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // 既定の「必ず付ける」だと、S3 互換の実装が知らない checksum 欄を断ることがある
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return (
    named.name === 'NoSuchKey' ||
    named.name === 'NotFound' ||
    named.$metadata?.httpStatusCode === 404
  );
}

async function toReadable(body: unknown): Promise<Readable | undefined> {
  if (body instanceof Readable) return body;
  if (body === undefined || body === null) return undefined;
  const web = body as { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (typeof web.transformToWebStream === 'function') {
    return Readable.fromWeb(web.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0]);
  }
  if (body instanceof Uint8Array) return Readable.from([body]);
  throw new Error('S3 の応答の本文を読めない形で受け取った');
}
