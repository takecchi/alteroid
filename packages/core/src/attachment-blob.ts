import { Readable } from 'node:stream';

/**
 * 添付の中身の置き場（Issue #4128 段2）。S3 互換のオブジェクトストレージを、S3 API で一般に書く（特定の事業者に寄せない）。
 *
 * pg の `attachments` には控えと `blob_key` だけを置き、中身はここへ置く。**接続先が未設定なら使わない**
 * （今までどおり pg の bytea）。このファイルは `attachment.ts` を読まない（`readAttachmentLimits` がここを読むため、循環を避ける）。
 */
export interface AttachmentBlobStore {
  /** `key` の中身を置く。長さは分からないストリームでよい。途中で body が投げたら、置き場に何も残さない。 */
  put(key: string, body: AsyncIterable<Uint8Array>): Promise<void>;
  /** 無ければ `undefined`。 */
  open(key: string): Promise<Readable | undefined>;
  /** 無い key は黙って成功する。 */
  remove(keys: readonly string[]): Promise<void>;
}

/** 試験用のインメモリの置き場。 */
export class MemoryAttachmentBlobStore implements AttachmentBlobStore {
  readonly #blobs = new Map<string, Buffer>();

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    this.#blobs.set(key, Buffer.concat(chunks));
  }

  async open(key: string): Promise<Readable | undefined> {
    const found = this.#blobs.get(key);
    return found === undefined ? undefined : Readable.from([found]);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.#blobs.delete(key);
  }

  /** 試験用: 置いてある key の一覧。 */
  keys(): string[] {
    return [...this.#blobs.keys()];
  }

  /** 試験用: 置いてある中身。 */
  peek(key: string): Buffer | undefined {
    return this.#blobs.get(key);
  }
}

/** 置き場の key。`attachments/<id>`。設定の prefix（`/` 終わりに正規化済み）があれば前に付ける。 */
export function attachmentBlobKey(id: string, prefix = ''): string {
  return `${prefix}attachments/${id}`;
}

export const ATTACHMENT_S3_BUCKET_ENV = 'ALTEROID_ATTACHMENT_S3_BUCKET';
export const ATTACHMENT_S3_ENDPOINT_ENV = 'ALTEROID_ATTACHMENT_S3_ENDPOINT';
export const ATTACHMENT_S3_ALLOW_HTTP_ENV = 'ALTEROID_ATTACHMENT_S3_ALLOW_HTTP';
export const ATTACHMENT_S3_REGION_ENV = 'ALTEROID_ATTACHMENT_S3_REGION';
export const ATTACHMENT_S3_ACCESS_KEY_ID_ENV = 'ALTEROID_ATTACHMENT_S3_ACCESS_KEY_ID';
export const ATTACHMENT_S3_SECRET_ACCESS_KEY_ENV = 'ALTEROID_ATTACHMENT_S3_SECRET_ACCESS_KEY';
export const ATTACHMENT_S3_PREFIX_ENV = 'ALTEROID_ATTACHMENT_S3_PREFIX';
export const ATTACHMENT_S3_FORCE_PATH_STYLE_ENV = 'ALTEROID_ATTACHMENT_S3_FORCE_PATH_STYLE';

export interface AttachmentBlobConfig {
  readonly bucket: string;
  readonly endpoint?: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `/` 終わり（空なら空）。 */
  readonly prefix: string;
  readonly forcePathStyle: boolean;
}

export type AttachmentBlobConfigResult =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly config: AttachmentBlobConfig }
  | { readonly kind: 'invalid'; readonly reason: string };

const TRUE_VALUES = new Set(['1', 'true']);

/**
 * 環境変数から置き場の設定を読む。`ALTEROID_ATTACHMENT_S3_BUCKET` が空・未設定なら `off`。
 * 鍵が欠けている・endpoint が不正なら `invalid`（**`reason` には環境変数の名前だけを載せ、値は載せない**）。
 */
export function readAttachmentBlobConfig(
  env: NodeJS.ProcessEnv = process.env,
): AttachmentBlobConfigResult {
  const get = (name: string): string => env[name]?.trim() ?? '';
  const bucket = get(ATTACHMENT_S3_BUCKET_ENV);
  if (bucket === '') return { kind: 'off' };

  const missing = [ATTACHMENT_S3_ACCESS_KEY_ID_ENV, ATTACHMENT_S3_SECRET_ACCESS_KEY_ENV].filter(
    (name) => get(name) === '',
  );
  if (missing.length > 0) {
    return {
      kind: 'invalid',
      reason: `${ATTACHMENT_S3_BUCKET_ENV} が設定されているのに ${missing.join('・')} が無い`,
    };
  }

  const endpointRaw = get(ATTACHMENT_S3_ENDPOINT_ENV);
  let endpoint: string | undefined;
  if (endpointRaw !== '') {
    let url: URL | undefined;
    try {
      url = new URL(endpointRaw);
    } catch {
      url = undefined;
    }
    const allowHttp = TRUE_VALUES.has(get(ATTACHMENT_S3_ALLOW_HTTP_ENV).toLowerCase());
    const protocolOk = url?.protocol === 'https:' || (allowHttp && url?.protocol === 'http:');
    if (url === undefined || !protocolOk) {
      return {
        kind: 'invalid',
        reason:
          `${ATTACHMENT_S3_ENDPOINT_ENV} が不正（https の URL でなければならない。` +
          `http は ${ATTACHMENT_S3_ALLOW_HTTP_ENV}=1 のときだけ）`,
      };
    }
    endpoint = endpointRaw;
  }

  const prefixRaw = get(ATTACHMENT_S3_PREFIX_ENV).replace(/^\/+/, '');
  const prefix = prefixRaw === '' || prefixRaw.endsWith('/') ? prefixRaw : `${prefixRaw}/`;

  return {
    kind: 'on',
    config: {
      bucket,
      ...(endpoint === undefined ? {} : { endpoint }),
      region: get(ATTACHMENT_S3_REGION_ENV) || 'auto',
      accessKeyId: get(ATTACHMENT_S3_ACCESS_KEY_ID_ENV),
      secretAccessKey: get(ATTACHMENT_S3_SECRET_ACCESS_KEY_ENV),
      prefix,
      forcePathStyle: TRUE_VALUES.has(get(ATTACHMENT_S3_FORCE_PATH_STYLE_ENV).toLowerCase()),
    },
  };
}
