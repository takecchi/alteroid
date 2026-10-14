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
import {
  attachmentBlobPartBytesFor,
  type AttachmentBlobConfig,
  type AttachmentBlobStore,
} from '@alteroid/core';

const DELETE_BATCH = 1000;

/** S3 へ繋ぐ期限（ms。#4689）。繋ぐだけなら数百 ms で済む。10 秒を超えたら経路が死んでいる。 */
export const S3_CONNECT_TIMEOUT_MS = 10_000;

/**
 * S3 との無通信の期限（ms。#4689）。ソケットに何も流れない時間で、流している間は切れない（2GiB の取り出しでも、流れが止まらない限り打ち切られない）。
 * 無期限にしない: 経路が半開きになると、添付の掃除の周回と `attachment_fetch` が止まったままになるため。
 */
export const S3_IDLE_TIMEOUT_MS = 60_000;

/**
 * S3 API で一般に書く（特定の事業者に寄せない）。key は呼び手が prefix 込みで渡す。ここでは足さない。
 * 失敗の文に key・資格・endpoint の値を載せない: 呼び手が stderr へ出すため。
 */
export class S3AttachmentBlobStore implements AttachmentBlobStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #partSize: number;
  readonly #idleMs: number;

  /** `maxObjectBytes` は置き場が受けうる最大の大きさ。省けば part は S3 の最小（5 MiB）。 */
  constructor(
    config: AttachmentBlobConfig,
    options: {
      readonly maxObjectBytes?: number;
      readonly client?: S3Client;
      /** 期限（試験が短くするための口）。既定 {@link S3_CONNECT_TIMEOUT_MS} / {@link S3_IDLE_TIMEOUT_MS}。 */
      readonly timeouts?: { readonly connectMs?: number; readonly idleMs?: number };
    } = {},
  ) {
    this.#bucket = config.bucket;
    this.#client = options.client ?? new S3Client(clientConfigOf(config, options.timeouts));
    this.#partSize = attachmentBlobPartBytesFor(options.maxObjectBytes ?? 0);
    this.#idleMs = options.timeouts?.idleMs ?? S3_IDLE_TIMEOUT_MS;
  }

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const upload = new Upload({
      client: this.#client,
      partSize: this.#partSize,
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
    armBodyIdleTimeout(response.Body, this.#idleMs);
    return toReadable(response.Body);
  }

  /** `LastModified` が無い要素は外す: 判定できないものは消さない側へ倒すため。 */
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

function clientConfigOf(
  config: AttachmentBlobConfig,
  timeouts: { readonly connectMs?: number; readonly idleMs?: number } = {},
): S3ClientConfig {
  return {
    // 期限を渡す（#4689）: 渡さないと SDK の HTTP の口（`@smithy/node-http-handler`）は接続にも無通信にも期限を持たない。
    // 無通信は `socketTimeout` で渡す: `requestTimeout` は全体の時間の期限で、しかも `throwOnRequestTimeout` を立てない限り警告を書くだけで打ち切らないため。
    // 全体の時間の期限は付けない: 2GiB の取り出しのように長く流れ続ける正当な要求を切らないため
    requestHandler: {
      connectionTimeout: timeouts.connectMs ?? S3_CONNECT_TIMEOUT_MS,
      socketTimeout: timeouts.idleMs ?? S3_IDLE_TIMEOUT_MS,
    },
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

/**
 * 本文を流している間の無通信の期限を、本文の側に掛け直す（#4689）。
 * SDK の `socketTimeout` は 6 秒以上だと 3 秒遅らせて登録し、その前に頭が届くと登録ごと取り消す。
 * だから頭がすぐ届いて本文の途中で止まった相手には効かず、`attachment_fetch` が返らない。
 * 本文が Node の `IncomingMessage` でないとき（試験の差し替えなど）は何もしない。
 */
function armBodyIdleTimeout(body: unknown, idleMs: number): void {
  const message = body as {
    setTimeout?: (ms: number, callback: () => void) => unknown;
    destroy?: (error: Error) => unknown;
  };
  if (typeof message.setTimeout !== 'function' || typeof message.destroy !== 'function') return;
  message.setTimeout(idleMs, () => {
    message.destroy?.(
      Object.assign(new Error(`S3 の本文が ${String(idleMs)} ms のあいだ流れなかった`), {
        name: 'TimeoutError',
      }),
    );
  });
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
