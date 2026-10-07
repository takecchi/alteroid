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

const ZWNJ = 0x200c;
const ZWJ = 0x200d;

/**
 * Canonical_Combining_Class=9（Virama）。JS の `\p{}` では引けないので表で持つ（Unicode の ccc=9 を手で写したもの。
 * 新しい Unicode で増えた文字は入らない）。
 */
const VIRAMA = new Set<number>([
  0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d3b, 0x0d3c, 0x0d4d, 0x0dca,
  0x0e3a, 0x0eba, 0x0f84, 0x1039, 0x103a, 0x1714, 0x1715, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa,
  0x1bab, 0x1bf2, 0x1bf3, 0x2d7f, 0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f,
  0x11046, 0x11070, 0x1107f, 0x110b9, 0x11133, 0x11134, 0x111c0, 0x11235, 0x112ea, 0x1134d, 0x11442,
  0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b, 0x11839, 0x1193d, 0x1193e, 0x119e0, 0x11a34, 0x11a47,
  0x11a99, 0x11c3f, 0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42,
]);

/** Joining_Type=R（右にだけつながる）の文字。アラビア文字・シリア文字の主なもの。 */
const JOIN_RIGHT = new Set<number>([
  0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648, 0x0671,
  0x0672, 0x0673, 0x0675, 0x0676, 0x0677, 0x0688, 0x0689, 0x068a, 0x068b, 0x068c, 0x068d, 0x068e,
  0x068f, 0x0690, 0x0691, 0x0692, 0x0693, 0x0694, 0x0695, 0x0696, 0x0697, 0x0698, 0x0699, 0x06c0,
  0x06c3, 0x06c4, 0x06c5, 0x06c6, 0x06c7, 0x06c8, 0x06c9, 0x06ca, 0x06cb, 0x06cd, 0x06cf, 0x06d2,
  0x06d3, 0x06d5, 0x06ee, 0x06ef, 0x0710, 0x0715, 0x0716, 0x0717, 0x0718, 0x0719, 0x071e, 0x0728,
  0x072a, 0x072c, 0x072f, 0x074d, 0x0759, 0x075a, 0x075b, 0x076b, 0x076c, 0x0771, 0x0773, 0x0774,
  0x0778, 0x0779,
]);

/** 文字（`\p{L}`）をすべて Joining_Type=D とみなすブロック（R の表と、非結合の 0621・0674 を除く）。 */
const JOINING_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0620, 0x06ff], // アラビア文字
  [0x0700, 0x074f], // シリア文字
  [0x0750, 0x077f], // アラビア文字補助
  [0x07c0, 0x07ff], // N'Ko
  [0x0870, 0x08ff], // アラビア文字拡張 B・A
  [0x1820, 0x18af], // モンゴル文字
  [0xa840, 0xa877], // パスパ文字
];

const LETTER = /^\p{L}$/u;
const MARK = /^[\p{Mn}\p{Me}]$/u;

/**
 * Joining_Type の近似（`\p{}` では引けないため）。T は Mn・Me だけ。Cf も本来は T だが、Cf は `_` に置き換わる
 * 文字で、文脈に使うと置き換えの前後で判定が変わり、冪等でなくなる。
 * 限界: 表に無いブロック（Adlam・Manichaean・Hanifi Rohingya など）は「つながらない」と扱うので、その間の
 * ZWNJ は `_` になる。ブロック内の文字は D とみなすので、本来は U の文字の隣でも残ることがある。
 */
function joiningType(cp: number): 'D' | 'R' | 'T' | undefined {
  const ch = String.fromCodePoint(cp);
  if (MARK.test(ch)) return 'T';
  if (JOIN_RIGHT.has(cp)) return 'R';
  if (cp === 0x0621 || cp === 0x0674) return undefined;
  if (!LETTER.test(ch)) return undefined;
  return JOINING_BLOCKS.some(([lo, hi]) => cp >= lo && cp <= hi) ? 'D' : undefined;
}

/** `index`（UTF-16 の位置）の直前のコードポイントと、その開始位置。 */
function codePointBefore(s: string, index: number): [number, number] | undefined {
  if (index <= 0) return undefined;
  const low = s.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = s.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return [s.codePointAt(index - 2) as number, index - 2];
  }
  return [low, index - 1];
}

/** 絵文字の後ろに付く修飾子（異体字セレクタ・肌色・キーキャップ）。ZWJ の前の判定で読み飛ばす。 */
const EMOJI_MODIFIER = /^[\u{FE0E}\u{FE0F}\u{20E3}\p{Emoji_Modifier}]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;

function precededByPictographic(s: string, index: number): boolean {
  let i = index;
  for (;;) {
    const before = codePointBefore(s, i);
    if (before === undefined) return false;
    const ch = String.fromCodePoint(before[0]);
    if (PICTOGRAPHIC.test(ch)) return true;
    if (!EMOJI_MODIFIER.test(ch)) return false;
    i = before[1];
  }
}

/**
 * ZWNJ / ZWJ（`index` の位置にある）を残してよい文脈か。IDNA の ContextJ（RFC 5892 Appendix A.1・A.2）に
 * 絵文字の ZWJ 連結を足したもの。判定は置き換わらない文字（Virama・文字・Mn・絵文字）だけを見る。
 */
function joinerHasContext(s: string, index: number): boolean {
  const before = codePointBefore(s, index);
  if (before !== undefined && VIRAMA.has(before[0])) return true;
  if (s.charCodeAt(index) === ZWJ) {
    // Why not: IDNA の ContextJ には絵文字の連結が無い。だが 👨‍👩‍👧 のような名前が黙って 👨_👩_👧 に
    // 変わる実害（#3882）があるので、IDNA の外の追加として、前後が絵文字のときだけ残す。
    const after = s.codePointAt(index + 1);
    return (
      after !== undefined &&
      PICTOGRAPHIC.test(String.fromCodePoint(after)) &&
      precededByPictographic(s, index)
    );
  }
  // ZWNJ: (L|D) T* ZWNJ T* (R|D)。
  let i = index;
  for (;;) {
    const p = codePointBefore(s, i);
    if (p === undefined) return false;
    const type = joiningType(p[0]);
    if (type === 'T') {
      i = p[1];
      continue;
    }
    if (type !== 'D') return false;
    break;
  }
  let j = index + 1;
  while (j < s.length) {
    const cp = s.codePointAt(j) as number;
    const type = joiningType(cp);
    if (type === 'T') {
      j += cp > 0xffff ? 2 : 1;
      continue;
    }
    return type === 'D' || type === 'R';
  }
  return false;
}

function sanitizeNameChars(text: string): string {
  return (
    toWellFormed(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0001-\u001f\u007f-\u009f/\\\p{Cf}]/gu, (ch, offset: number, whole: string) => {
        const code = ch.charCodeAt(0);
        return (code === ZWNJ || code === ZWJ) && joinerHasContext(whole, offset) ? ch : '_';
      })
      .trim()
  );
}

export function normalizeAttachmentName(raw: string): string {
  let name = sanitizeNameChars(stripNul(raw));
  if (name.length > ATTACHMENT_NAME_MAX_LENGTH) {
    // 切ったあとにも判定と trim をやり直す: 切り口に残った ZWJ や末尾の空白が、もう一度通したときに変わるため
    name = sanitizeNameChars(name.slice(0, ATTACHMENT_NAME_MAX_LENGTH));
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
