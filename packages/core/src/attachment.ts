import { randomUUID } from 'node:crypto';

import { sha256Hex } from './auth.js';
import { assertNoNul, stripNul } from './nul-guard.js';

export interface AttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly conversationId?: string;
  readonly externalEventId?: string;
  readonly uploadedBy?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AttachmentPutInput {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly conversationId?: string;
  readonly uploadedBy?: string;
}

export interface AttachmentBindResult {
  readonly bound: string[];
  /** この呼び出しで新しく結んだ id。断るときに `unbind` してよいのはこれだけ。 */
  readonly newlyBound: string[];
  readonly missing: string[];
  readonly conflicts: string[];
}

export interface AttachmentStore {
  put(input: AttachmentPutInput): Promise<AttachmentMeta>;
  get(id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | undefined>;
  getMeta(id: string): Promise<AttachmentMeta | undefined>;
  bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult>;
  bindToExternalEvent(ids: readonly string[], eventId: string): Promise<AttachmentBindResult>;
  /** 呼び手は自分の呼び出しで新しく結んだ id だけを渡すこと（以前から結んであった id を渡すと、その結び付けも戻る）。 */
  unbind(ids: readonly string[], target: AttachmentBindTarget): Promise<string[]>;
  prune(now: Date): Promise<number>;
}

const MIB = 1024 * 1024;

export const ATTACHMENT_MAX_IMAGE_BYTES_DEFAULT = 5 * MIB;
export const ATTACHMENT_MAX_FILE_BYTES_DEFAULT = 25 * MIB;
export const ATTACHMENT_MAX_PER_MESSAGE_DEFAULT = 10;
export const ATTACHMENT_MAX_TOTAL_BYTES_DEFAULT = 50 * MIB;
export const ATTACHMENT_RETENTION_DAYS_DEFAULT = 30;
// 20 枚を超えると API は全画像に 2000px の制限を掛ける
export const ATTACHMENT_MAX_TURN_IMAGES_DEFAULT = 20;
// base64 で約 21.4 MB: API の 1 リクエスト 32 MB に収める
export const ATTACHMENT_MAX_TURN_IMAGE_BYTES_DEFAULT = 16 * MIB;
// 巨大な値は `new Date(...).toISOString()` が `RangeError: Invalid time value` を投げて全 `put` が 500 になる
export const ATTACHMENT_RETENTION_DAYS_MAX = 36_500;
export const ATTACHMENT_UNBOUND_TTL_MS = 60 * 60_000;

export const ATTACHMENT_MAX_IMAGE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_IMAGE_BYTES';
export const ATTACHMENT_MAX_FILE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_FILE_BYTES';
export const ATTACHMENT_MAX_PER_MESSAGE_ENV = 'ALTEROID_ATTACHMENT_MAX_PER_MESSAGE';
export const ATTACHMENT_MAX_TOTAL_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_TOTAL_BYTES';
export const ATTACHMENT_RETENTION_DAYS_ENV = 'ALTEROID_ATTACHMENT_RETENTION_DAYS';
export const ATTACHMENT_MAX_TURN_IMAGES_ENV = 'ALTEROID_ATTACHMENT_MAX_TURN_IMAGES';
export const ATTACHMENT_MAX_TURN_IMAGE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES';

export interface AttachmentLimits {
  readonly maxImageBytes: number;
  readonly maxFileBytes: number;
  readonly maxPerMessage: number;
  readonly maxTotalBytes: number;
  readonly retentionDays: number;
}

// AttachmentLimits と型を分ける: 受け付け・保存を妨げず、ターン時に画像として渡すかどうかだけを決めるため
export interface TurnImageLimits {
  readonly maxTurnImages: number;
  readonly maxTurnImageBytes: number;
}

export type TurnAttachmentLimits = AttachmentLimits & Partial<TurnImageLimits>;

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxImageBytes: ATTACHMENT_MAX_IMAGE_BYTES_DEFAULT,
  maxFileBytes: ATTACHMENT_MAX_FILE_BYTES_DEFAULT,
  maxPerMessage: ATTACHMENT_MAX_PER_MESSAGE_DEFAULT,
  maxTotalBytes: ATTACHMENT_MAX_TOTAL_BYTES_DEFAULT,
  retentionDays: ATTACHMENT_RETENTION_DAYS_DEFAULT,
};

export const DEFAULT_TURN_IMAGE_LIMITS: TurnImageLimits = {
  maxTurnImages: ATTACHMENT_MAX_TURN_IMAGES_DEFAULT,
  maxTurnImageBytes: ATTACHMENT_MAX_TURN_IMAGE_BYTES_DEFAULT,
};

export function turnImageLimitsOf(limits: Partial<TurnImageLimits>): TurnImageLimits {
  return {
    maxTurnImages: limits.maxTurnImages ?? DEFAULT_TURN_IMAGE_LIMITS.maxTurnImages,
    maxTurnImageBytes: limits.maxTurnImageBytes ?? DEFAULT_TURN_IMAGE_LIMITS.maxTurnImageBytes,
  };
}

export function formatImageLimit(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes % mib === 0 ? `${bytes / mib} MiB` : `${bytes} B`;
}

export type TurnImageOverReason = 'count' | 'bytes';

export class TurnImageBudget {
  #count = 0;
  #bytes = 0;
  readonly #limits: TurnImageLimits;

  constructor(limits: Partial<TurnImageLimits>) {
    this.#limits = turnImageLimitsOf(limits);
  }

  take(size: number): TurnImageOverReason | undefined {
    if (this.#count + 1 > this.#limits.maxTurnImages) return 'count';
    if (this.#bytes + size > this.#limits.maxTurnImageBytes) return 'bytes';
    this.#count += 1;
    this.#bytes += size;
    return undefined;
  }
}

export function turnImageOverNotice(
  reason: TurnImageOverReason,
  turnLimits: Partial<TurnImageLimits>,
  openHint: string,
): string {
  const limits = turnImageLimitsOf(turnLimits);
  return reason === 'count'
    ? `（このターンの画像は上限（${limits.maxTurnImages} 枚）までで、これは超えた分なので画像としては渡していない。${openHint}）`
    : `（このターンの画像の合計の上限（${formatImageLimit(limits.maxTurnImageBytes)}）を超えるので画像としては渡していない。${openHint}）`;
}

export interface AttachmentLimitsConfig {
  readonly limits: AttachmentLimits & TurnImageLimits;
  readonly notes: string[];
}

export function readAttachmentLimits(env: NodeJS.ProcessEnv = process.env): AttachmentLimitsConfig {
  const notes: string[] = [];
  const read = (name: string, fallback: number, max?: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw.length === 0) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      notes.push(`${name}="${raw}" は正の整数として読めないので既定 ${fallback} を使う`);
      return fallback;
    }
    if (max !== undefined && parsed > max) {
      notes.push(`${name}="${raw}" は上限 ${max} を超えているので既定 ${fallback} を使う`);
      return fallback;
    }
    return parsed;
  };
  return {
    limits: {
      maxImageBytes: read(ATTACHMENT_MAX_IMAGE_BYTES_ENV, ATTACHMENT_MAX_IMAGE_BYTES_DEFAULT),
      maxFileBytes: read(ATTACHMENT_MAX_FILE_BYTES_ENV, ATTACHMENT_MAX_FILE_BYTES_DEFAULT),
      maxPerMessage: read(ATTACHMENT_MAX_PER_MESSAGE_ENV, ATTACHMENT_MAX_PER_MESSAGE_DEFAULT),
      maxTotalBytes: read(ATTACHMENT_MAX_TOTAL_BYTES_ENV, ATTACHMENT_MAX_TOTAL_BYTES_DEFAULT),
      retentionDays: read(
        ATTACHMENT_RETENTION_DAYS_ENV,
        ATTACHMENT_RETENTION_DAYS_DEFAULT,
        ATTACHMENT_RETENTION_DAYS_MAX,
      ),
      maxTurnImages: read(ATTACHMENT_MAX_TURN_IMAGES_ENV, ATTACHMENT_MAX_TURN_IMAGES_DEFAULT),
      maxTurnImageBytes: read(
        ATTACHMENT_MAX_TURN_IMAGE_BYTES_ENV,
        ATTACHMENT_MAX_TURN_IMAGE_BYTES_DEFAULT,
      ),
    },
    notes,
  };
}

export type AttachmentRejection =
  'too_large' | 'magic_mismatch' | 'too_many' | 'total_too_large' | 'media_type_missing' | 'empty';

export const ATTACHMENT_EMPTY_MESSAGE = '空のファイルは添えられない';

export class AttachmentRejectedError extends Error {
  readonly code: AttachmentRejection;

  constructor(code: AttachmentRejection, message: string) {
    super(message);
    this.name = 'AttachmentRejectedError';
    this.code = code;
  }
}

export const ATTACHMENT_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AttachmentImageMediaType = (typeof ATTACHMENT_IMAGE_MEDIA_TYPES)[number];

export function normalizeAttachmentMediaType(raw: string): string {
  return stripNul(raw).split(';')[0]!.trim().toLowerCase();
}

export function isAttachmentImageMediaType(
  mediaType: string,
): mediaType is AttachmentImageMediaType {
  return (ATTACHMENT_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

function startsWith(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

export function sniffAttachmentImageType(bytes: Uint8Array): AttachmentImageMediaType | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp';
  }
  return undefined;
}

// tsconfig の `lib` が ES2023 なので、`toWellFormed`（ES2024）は最小の型だけ足す
function toWellFormed(value: string): string {
  return (value as string & { toWellFormed(): string }).toWellFormed();
}

export const ATTACHMENT_NAME_MAX_LENGTH = 255;

export function normalizeAttachmentName(raw: string): string {
  let name = toWellFormed(stripNul(raw))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0001-\u001f\u007f-\u009f/\\\p{Cf}]/gu, '_')
    .trim();
  if (name.length > ATTACHMENT_NAME_MAX_LENGTH) {
    // 切ったあとにも前後の空白を除く: 除かないと、もう一度通したときに名前が変わる
    name = toWellFormed(name.slice(0, ATTACHMENT_NAME_MAX_LENGTH)).trim();
  }
  return name === '' || name === '.' || name === '..' ? 'file' : name;
}

// NAME_MAX（255）に余裕を残す
export const ATTACHMENT_DISK_NAME_MAX_BYTES = 200;

const ATTACHMENT_DISK_EXT_MAX_BYTES = 32;

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

/** ディスク上のパスに使う名前。表示や控え（`AttachmentMeta.name`・通知行）には使わない。 */
export function attachmentDiskName(name: string): string {
  const normalized = normalizeAttachmentName(name);
  if (Buffer.byteLength(normalized, 'utf8') <= ATTACHMENT_DISK_NAME_MAX_BYTES) return normalized;
  const dot = normalized.lastIndexOf('.');
  const ext =
    dot > 0 && Buffer.byteLength(normalized.slice(dot), 'utf8') <= ATTACHMENT_DISK_EXT_MAX_BYTES
      ? normalized.slice(dot)
      : '';
  const stem = truncateUtf8(
    ext === '' ? normalized : normalized.slice(0, dot),
    ATTACHMENT_DISK_NAME_MAX_BYTES - Buffer.byteLength(ext, 'utf8'),
  ).trimEnd();
  return stem === '' ? `file${ext}` : `${stem}${ext}`;
}

export function validateAttachmentInput(
  input: Pick<AttachmentPutInput, 'name' | 'mediaType' | 'bytes'>,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): { name: string; mediaType: string } {
  const mediaType = normalizeAttachmentMediaType(input.mediaType);
  if (mediaType === '') {
    throw new AttachmentRejectedError('media_type_missing', 'mediaType が空');
  }
  if (input.bytes.length === 0) {
    throw new AttachmentRejectedError('empty', ATTACHMENT_EMPTY_MESSAGE);
  }
  const image = isAttachmentImageMediaType(mediaType);
  const max = image ? limits.maxImageBytes : limits.maxFileBytes;
  if (input.bytes.length > max) {
    throw new AttachmentRejectedError(
      'too_large',
      `${image ? '画像' : 'ファイル'}は 1 つ ${max} バイトまで（${input.bytes.length} バイト）`,
    );
  }
  if (image && sniffAttachmentImageType(input.bytes) !== mediaType) {
    throw new AttachmentRejectedError(
      'magic_mismatch',
      `宣言された ${mediaType} と中身の先頭が一致しない`,
    );
  }
  return { name: normalizeAttachmentName(input.name), mediaType };
}

export function validateAttachmentBatch(
  sizes: readonly number[],
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): void {
  if (sizes.length > limits.maxPerMessage) {
    throw new AttachmentRejectedError(
      'too_many',
      `1 発言に添えられるのは ${limits.maxPerMessage} 個まで（${sizes.length} 個）`,
    );
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > limits.maxTotalBytes) {
    throw new AttachmentRejectedError(
      'total_too_large',
      `1 発言の合計は ${limits.maxTotalBytes} バイトまで（${total} バイト）`,
    );
  }
}

export interface AttachmentStoreOptions {
  readonly limits?: AttachmentLimits;
  readonly now?: () => Date;
}

export function prepareAttachment(
  input: AttachmentPutInput,
  limits: AttachmentLimits,
  now: Date,
): AttachmentMeta {
  const { name, mediaType } = validateAttachmentInput(input, limits);
  if (input.conversationId !== undefined) assertNoNul('conversationId', input.conversationId);
  return {
    id: randomUUID(),
    name,
    mediaType,
    size: input.bytes.length,
    sha256: sha256Hex(input.bytes),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.uploadedBy === undefined || input.uploadedBy === ''
      ? {}
      : { uploadedBy: stripNul(input.uploadedBy) }),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + limits.retentionDays * 86_400_000).toISOString(),
  };
}

export function isAttachmentExpired(meta: AttachmentMeta, now: Date): boolean {
  return Date.parse(meta.expiresAt) <= now.getTime();
}

export function isAttachmentPrunable(meta: AttachmentMeta, now: Date): boolean {
  if (isAttachmentExpired(meta, now)) return true;
  return (
    meta.conversationId === undefined &&
    meta.externalEventId === undefined &&
    Date.parse(meta.createdAt) + ATTACHMENT_UNBOUND_TTL_MS <= now.getTime()
  );
}

export type AttachmentBindTarget = { conversationId: string } | { externalEventId: string };

export function isBoundTo(meta: AttachmentMeta, target: AttachmentBindTarget): boolean {
  return 'conversationId' in target
    ? meta.conversationId === target.conversationId
    : meta.externalEventId === target.externalEventId;
}

export function canBindAttachmentTo(meta: AttachmentMeta, target: AttachmentBindTarget): boolean {
  if ('conversationId' in target) {
    return (
      meta.externalEventId === undefined &&
      (meta.conversationId ?? target.conversationId) === target.conversationId
    );
  }
  return (
    meta.conversationId === undefined &&
    (meta.externalEventId ?? target.externalEventId) === target.externalEventId
  );
}
