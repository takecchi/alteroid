import { Readable } from 'node:stream';

/**
 * 添付の中身の置き場。S3 API で一般に書く（特定の事業者に寄せない）。
 * このファイルは `attachment.ts` を読まない: `readAttachmentLimits` がここを読むため、循環する。
 */
export interface AttachmentBlobStore {
  /** 途中で body が投げたら、置き場に何も残さない。 */
  put(key: string, body: AsyncIterable<Uint8Array>): Promise<void>;
  open(key: string): Promise<Readable | undefined>;
  /** 無い key は黙って成功する。 */
  remove(keys: readonly string[]): Promise<void>;
  /** 置いた時刻（`lastModified`）が分からない要素は列挙から外す: 判定できないものは消さない側へ倒すため。 */
  list(prefix: string): AsyncIterable<{ key: string; lastModified: Date }>;
}

/** 試験用のインメモリの置き場。 */
export class MemoryAttachmentBlobStore implements AttachmentBlobStore {
  readonly #blobs = new Map<string, Buffer>();
  readonly #modified = new Map<string, Date>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async put(key: string, body: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    this.#blobs.set(key, Buffer.concat(chunks));
    this.#modified.set(key, this.#now());
  }

  async *list(prefix: string): AsyncGenerator<{ key: string; lastModified: Date }> {
    for (const key of [...this.#blobs.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const lastModified = this.#modified.get(key);
      if (lastModified !== undefined) yield { key, lastModified };
    }
  }

  async open(key: string): Promise<Readable | undefined> {
    const found = this.#blobs.get(key);
    return found === undefined ? undefined : Readable.from([found]);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.#blobs.delete(key);
      this.#modified.delete(key);
    }
  }

  setModified(key: string, at: Date): void {
    if (this.#blobs.has(key)) this.#modified.set(key, at);
  }

  keys(): string[] {
    return [...this.#blobs.keys()];
  }

  peek(key: string): Buffer | undefined {
    return this.#blobs.get(key);
  }
}

export function attachmentBlobKey(id: string, prefix = ''): string {
  return `${prefix}attachments/${id}`;
}

/** 掃除は、この形に完全に合う key にしか触れない: 同じ置き場の他の物を消さないため。 */
export const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 控えの無い blob を消してよくなるまでの猶予。置いてから行を INSERT するまでの間の blob を消さないため、
 * 上げの1リクエストの持ち時間（`ATTACHMENT_REQUEST_TIMEOUT_MS`。1時間）より長くする。
 */
export const ATTACHMENT_ORPHAN_BLOB_GRACE_MS = 24 * 60 * 60_000;

/** `prefix` の下の、掃除の対象になりうる key の接頭辞（`<prefix>attachments/`）。 */
export function attachmentBlobListPrefix(prefix = ''): string {
  return attachmentBlobKey('', prefix);
}

export function isAttachmentBlobKey(key: string, prefix = ''): boolean {
  const head = attachmentBlobListPrefix(prefix);
  return key.startsWith(head) && ATTACHMENT_ID_PATTERN.test(key.slice(head.length));
}

/** key と値は載せない。 */
export interface AttachmentBlobSweepResult {
  readonly listed: number;
  /** 形・猶予・控えの無さのすべてを満たした件数。 */
  readonly candidates: number;
  readonly removed: number;
  readonly failed: number;
  /** key と値は載せない。 */
  readonly reason?: string;
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

/** `invalid` の `reason` には環境変数の名前だけを載せ、値は載せない: 鍵が漏れるため。 */
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
