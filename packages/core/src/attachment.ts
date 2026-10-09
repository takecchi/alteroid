import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { readAttachmentBlobConfig } from './attachment-blob.js';
import {
  ATTACHMENT_MAX_IMAGE_DIMENSION,
  readAttachmentImageSize,
} from './attachment-image-size.js';
import {
  attachmentMaxBytes,
  attachmentTooLargeMessage,
  isLargeAttachmentSize,
  attachmentTooManyMessage,
  attachmentTotalTooLargeMessage,
} from './attachment-wording.js';
import { sha256Hex } from './auth.js';
import { assertNoNul, stripNul } from './nul-guard.js';

/**
 * 添付ファイルの置き場（Issue #3111 段1a。**置き場所だけ**で、HTTP・クローン・Web はまだ触らない）。
 *
 * **記憶（memory）とは独立である。** 添付の中身は記憶へ書かない。人間が会話に添えた
 * 画像・動画・ファイルのバイト列を、期限つきで預かるだけの場所である。
 *
 * ## 寿命
 *
 * - `expiresAt`（既定: 作成から30日）を過ぎたものは {@link AttachmentStore.prune} が消す。
 * - **どこへも結び付いていない**（`conversationId` も `externalEventId` も `managerReportId` も無い）まま
 *   作成から1時間たったものも消す（アップロードしただけで送らなかった残骸）。結び付けは {@link AttachmentStore.bind}。
 *
 * - **保存の印（`keptAt`。#4126 P4）が付いたものは、①②のどちらでも消さない**（期限を持たない）。
 *   外すと外した時刻から保持日数後に期限が入る（{@link AttachmentStore.setKept}）。
 *
 * ## NUL
 *
 * 鍵（`id`・`conversationId`）の NUL は書く口では {@link NulNotAllowedError} で断り、読む口
 * （`get`・`getMeta`）は「無い」と答える（`nul-guard.ts` の決め）。ファイル名は NUL・孤立サロゲートを
 * 落として残す（{@link normalizeAttachmentName}）。
 */

/**
 * クローンが自分の手元のファイルを置き場へ入れた（`file_put`）ときの `uploadedBy`。
 * `uploadedBy` は自由な識別子の文字列で、値の一覧を型や zod では持たない（`operator` / `account:<id>` /
 * `integration:<keyId>` も同じ）ので、足すのはこの定数と文書だけである。
 */
export const ATTACHMENT_UPLOADED_BY_CLONE = 'clone';

/** 添付1つの控え。中身（bytes）は持たない。 */
export interface AttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly conversationId?: string;
  readonly externalEventId?: string;
  /**
   * 結び付けたマネージャーの報告の id（#4126 P2b。担い手が報告に添えて届いたファイル）。**結び付け先は会話・外部イベント・
   * 報告のどれか1つ**（{@link AttachmentStore.bindToManagerReport}）。未結び付けなら無い。
   */
  readonly managerReportId?: string;
  /**
   * 誰が上げたか（認証済みの主体を表す識別子。例 `operator` / `account:<id>`）。**中身ではなく識別子だけ**。
   * 連携の鍵が上げたものは `integration:<keyId>`（#3113 段3）、クローンが `file_put` で上げたものは
   * {@link ATTACHMENT_UPLOADED_BY_CLONE}（`clone`。#4126）。上げた主体が分からない・記録しない経路では無い。
   */
  readonly uploadedBy?: string;
  readonly createdAt: string;
  /**
   * ISO 8601。**保存中（{@link AttachmentMeta.keptAt} がある間）は持たない**（期限なし。#4126 P4）。
   * 保存を外すと、外した時刻から保持日数後が入る。
   */
  readonly expiresAt?: string;
  /**
   * 保存の印を付けた時刻（ISO 8601。#4126 P4）。**在る間は期限（{@link AttachmentMeta.expiresAt}）でも
   * 未結び付け1時間の掃除でも消えない**。外すと無くなる（{@link AttachmentStore.setKept}）。
   */
  readonly keptAt?: string;
  /**
   * 保存の印を外した時刻（ISO 8601。#4126 P4）。**在るものには未結び付け1時間の掃除を掛けない**
   * （一度保存されたものは「上げただけで使わなかった残骸」ではない。外した時刻から保持日数後の期限だけで消える）。
   * 付け直すと無くなる。
   */
  readonly releasedAt?: string;
}

export interface AttachmentPutInput {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** 預けた時点で保存の印を付ける（`POST /attachments?keep=1`。#4126 P4）。 */
  readonly kept?: boolean;
  /** 最初から結び付けて置くとき。無ければ未結び付け（後で `bind`）。 */
  readonly conversationId?: string;
  readonly uploadedBy?: string;
}

/** {@link AttachmentStore.putStream} の入力。{@link AttachmentPutInput} の `bytes` を `body` に替えたもの（#4128 段1）。 */
export interface AttachmentPutStreamInput extends Omit<AttachmentPutInput, 'bytes'> {
  readonly body: AsyncIterable<Uint8Array>;
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
  /**
   * 中身をストリームで預ける（#4128 段1）。{@link put} と同じ検査・同じ断り（`AttachmentRejectedError`）で、
   * 上限は**流しながら数えて**掛ける（超えた時点で読むのを止める。超えた分を溜めない）。
   * 断った時・`body` が途中で投げた時は、控えも中身も残さない（`body` の例外はそのまま投げる）。
   */
  putStream(input: AttachmentPutStreamInput): Promise<AttachmentMeta>;
  /** 中身をストリームで読む（#4128 段1）。期限切れ・無いものは {@link get} と同じ判定で `undefined`。 */
  open(id: string): Promise<{ meta: AttachmentMeta; stream: Readable } | undefined>;
  getMeta(id: string): Promise<AttachmentMeta | undefined>;
  bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult>;
  bindToExternalEvent(ids: readonly string[], eventId: string): Promise<AttachmentBindResult>;
  /**
   * マネージャーの報告（担い手が報告に添えて届いたファイルの受け皿。#4126 P2b）へ結び付ける。{@link bind} と同じ規則で、
   * 冪等・別の宛先に結び付いていたものは `conflicts`・無いものは `missing`。
   * 結び付いたものは {@link isAttachmentPrunable} の「未結び付け」に数えない（1時間の掃除に掛からない）。
   */
  bindToManagerReport(ids: readonly string[], reportId: string): Promise<AttachmentBindResult>;
  /**
   * 結び付けを戻す（{@link bind} / {@link bindToExternalEvent} / {@link bindToManagerReport} の取り消し）。**その `target` に結び付いている id だけ**を
   * 未結び付けへ戻し、戻した id を返す。未結び付け・別の宛先に結び付いている・無い id は触らない（返さない）。
   * 冪等。呼び手は「自分の呼び出しで新しく結んだ id」だけを渡すこと（以前から同じ宛先に結んであった id を渡すと、
   * その結び付けも戻る）。
   */
  unbind(ids: readonly string[], target: AttachmentBindTarget): Promise<string[]>;
  prune(now: Date): Promise<number>;
  /**
   * 保存の印を付ける／外す（#4126 P4）。更新後の控えを返す。無い・期限切れは `undefined`（`now` で判定する）。
   * 付ける＝`keptAt = now`・`expiresAt` を外す（すでに保存中なら何も変えない＝`keptAt` を動かさない）。
   * 外す＝`keptAt` を外し `expiresAt = now + 保持日数`（外した瞬間に作成からの期限で消えないように）。
   * 保存中でないものを外しても何も変えない（期限を延ばさない）。
   */
  setKept(id: string, kept: boolean, now: Date): Promise<AttachmentMeta | undefined>;
  /** 中身と控えを消す。**生きていたもの**（期限内）を消したら `true`、無い・期限切れは `false`（期限切れの残骸は消す）。 */
  remove(id: string): Promise<boolean>;
  /**
   * 控えの一覧（#4126 P4）。**中身を読まない**（pg は bytes 列を SELECT しない）。期限切れは含めない。
   * 新しい順（作成日時の降順、同じなら id の降順）。`cursor` は前のページの `nextCursor`（不正なら
   * {@link AttachmentCursorError}）。`limit` の件数だけ返し、続きがあれば `nextCursor` を付ける。
   */
  list(query: AttachmentListQuery): Promise<AttachmentListPage>;
  /** 期限内の全体の使用量（#4126 P4）。合計と出所ごと。 */
  usage(): Promise<AttachmentUsage>;
  /** 全部消す（ワークスペースのリセット用。#4006）。保存したものも含む。消した件数を返す。 */
  clear(): Promise<number>;
}

/** 出所の分類（{@link classifyAttachmentFrom}）。 */
export const ATTACHMENT_FROM_CLASSES = [
  'human',
  'clone',
  'manager',
  'integration',
  'unknown',
] as const;

export type AttachmentFromClass = (typeof ATTACHMENT_FROM_CLASSES)[number];

/**
 * 上げた主体（{@link AttachmentMeta.uploadedBy}）の分類。`operator`・`account:*` は人間、`clone` はクローン、
 * `manager:*` はマネージャー（担い手）、`integration:*` は連携の鍵。それ以外・無しは `unknown`。
 * pg は同じ分類を SQL で書く（`attachments.ts` の `fromCondition`）。
 */
export function classifyAttachmentFrom(uploadedBy: string | undefined): AttachmentFromClass {
  if (uploadedBy === undefined) return 'unknown';
  if (uploadedBy === 'operator' || uploadedBy.startsWith('account:')) return 'human';
  if (uploadedBy === ATTACHMENT_UPLOADED_BY_CLONE) return 'clone';
  if (uploadedBy.startsWith('manager:')) return 'manager';
  if (uploadedBy.startsWith('integration:')) return 'integration';
  return 'unknown';
}

export interface AttachmentListQuery {
  /** `true`＝保存中だけ・`false`＝保存していないものだけ・無し＝両方。 */
  readonly kept?: boolean;
  readonly from?: AttachmentFromClass;
  readonly conversationId?: string;
  /** 名前の部分一致（大文字小文字を問わない）。 */
  readonly q?: string;
  readonly cursor?: string;
  /** 1ページの件数（1 以上）。 */
  readonly limit: number;
}

export interface AttachmentListPage {
  readonly items: AttachmentMeta[];
  readonly nextCursor?: string;
}

export interface AttachmentUsageBucket {
  readonly count: number;
  readonly totalBytes: number;
}

export interface AttachmentUsage extends AttachmentUsageBucket {
  readonly byFrom: Readonly<Record<AttachmentFromClass, AttachmentUsageBucket>>;
}

/** 空の使用量（件数 0・0 バイト、出所は全部 0）。 */
export function emptyAttachmentUsage(): {
  count: number;
  totalBytes: number;
  byFrom: Record<AttachmentFromClass, { count: number; totalBytes: number }>;
} {
  return {
    count: 0,
    totalBytes: 0,
    byFrom: Object.fromEntries(
      ATTACHMENT_FROM_CLASSES.map((from) => [from, { count: 0, totalBytes: 0 }]),
    ) as Record<AttachmentFromClass, { count: number; totalBytes: number }>,
  };
}

/** ページ送りの印（`cursor`）が読めない。 */
export class AttachmentCursorError extends Error {
  constructor() {
    super('cursor が読めない');
    this.name = 'AttachmentCursorError';
  }
}

/** 一覧の並び（新しい順。作成日時の降順、同じなら id の降順）で、`meta` の次から始める印。 */
export function encodeAttachmentCursor(meta: Pick<AttachmentMeta, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify([meta.createdAt, meta.id]), 'utf8').toString('base64url');
}

/** {@link encodeAttachmentCursor} を戻す。読めなければ {@link AttachmentCursorError}。 */
export function decodeAttachmentCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      new Date(parsed[0]).toISOString() === parsed[0] &&
      !parsed[1].includes('\u0000')
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // 下で同じ例外へ倒す
  }
  throw new AttachmentCursorError();
}

/** 一覧の条件に合うか（インメモリ・fs が使う。pg は同じ条件を SQL で書く）。期限切れの除外は呼び手が先に行う。 */
export function matchesAttachmentListQuery(
  meta: AttachmentMeta,
  query: Pick<AttachmentListQuery, 'kept' | 'from' | 'conversationId' | 'q'>,
): boolean {
  if (query.kept !== undefined && (meta.keptAt !== undefined) !== query.kept) return false;
  if (query.from !== undefined && classifyAttachmentFrom(meta.uploadedBy) !== query.from)
    return false;
  if (query.conversationId !== undefined && meta.conversationId !== query.conversationId)
    return false;
  if (query.q !== undefined && !meta.name.toLowerCase().includes(query.q.toLowerCase()))
    return false;
  return true;
}

/**
 * 控えの並びを整えて1ページ切り出す（インメモリ・fs が使う。`metas` は条件に合うものだけ）。
 * 新しい順（作成日時の降順、同じなら id の降順。UTF-16 の順）。
 */
export function pageAttachmentMetas(
  metas: readonly AttachmentMeta[],
  query: Pick<AttachmentListQuery, 'cursor' | 'limit'>,
): AttachmentListPage {
  const after = query.cursor === undefined ? undefined : decodeAttachmentCursor(query.cursor);
  const sorted = [...metas].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  const rest =
    after === undefined
      ? sorted
      : sorted.filter(
          (meta) =>
            meta.createdAt < after.createdAt ||
            (meta.createdAt === after.createdAt && meta.id < after.id),
        );
  const limit = Math.max(1, Math.floor(query.limit));
  const items = rest.slice(0, limit);
  return rest.length > limit
    ? { items, nextCursor: encodeAttachmentCursor(items[items.length - 1]!) }
    : { items };
}

/** 使用量へ1件足す（インメモリ・fs が使う）。 */
export function addToAttachmentUsage(
  usage: ReturnType<typeof emptyAttachmentUsage>,
  meta: Pick<AttachmentMeta, 'size' | 'uploadedBy'>,
): void {
  const bucket = usage.byFrom[classifyAttachmentFrom(meta.uploadedBy)];
  bucket.count += 1;
  bucket.totalBytes += meta.size;
  usage.count += 1;
  usage.totalBytes += meta.size;
}

const MIB = 1024 * 1024;

export const ATTACHMENT_MAX_IMAGE_BYTES_DEFAULT = 5 * MIB;
export const ATTACHMENT_MAX_FILE_BYTES_DEFAULT = 25 * MIB;
// 外部ストレージが有効なときだけ効く、画像以外の大きいファイルの別枠（#4128 段2）
export const ATTACHMENT_MAX_LARGE_FILE_BYTES_DEFAULT = 2048 * MIB;
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
export const ATTACHMENT_MAX_LARGE_FILE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES';
export const ATTACHMENT_MAX_PER_MESSAGE_ENV = 'ALTEROID_ATTACHMENT_MAX_PER_MESSAGE';
export const ATTACHMENT_MAX_TOTAL_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_TOTAL_BYTES';
export const ATTACHMENT_RETENTION_DAYS_ENV = 'ALTEROID_ATTACHMENT_RETENTION_DAYS';
export const ATTACHMENT_MAX_TURN_IMAGES_ENV = 'ALTEROID_ATTACHMENT_MAX_TURN_IMAGES';
export const ATTACHMENT_MAX_TURN_IMAGE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES';

export interface AttachmentLimits {
  readonly maxImageBytes: number;
  readonly maxFileBytes: number;
  /**
   * 外部ストレージが有効なときだけ効く、画像以外の1つの上限の別枠（#4128 段2）。0 は枠なし。
   * 画像以外の1つの上限は {@link attachmentMaxBytes}（`maxLargeFileBytes > 0` なら `maxFileBytes` との大きいほう）。
   */
  readonly maxLargeFileBytes: number;
  readonly maxPerMessage: number;
  readonly maxTotalBytes: number;
  readonly retentionDays: number;
}

// 添付1つの上限（core の検査は全部これに揃える）。軽い口（attachment-wording）が正本で、Web・CLI も同じものを使う
export { attachmentMaxBytes };

/** 本文を受ける口（`POST /attachments`）が掛ける上限: 画像の上限と画像以外の1つの上限の大きいほう。 */
export function attachmentBodyMaxBytes(
  limits: Pick<AttachmentLimits, 'maxImageBytes' | 'maxFileBytes' | 'maxLargeFileBytes'>,
): number {
  return Math.max(limits.maxImageBytes, attachmentMaxBytes(limits, false));
}

/** 1発言の検査の1つぶん。`image` は画像かどうか（大きいファイルの判定に要る）。 */
export interface AttachmentBatchItem {
  readonly size: number;
  readonly image: boolean;
}

/** 控え（`size` と `mediaType` を持つもの）から検査の1つぶんを作る。 */
export function attachmentBatchItemOf(meta: {
  readonly size: number;
  readonly mediaType: string;
}): AttachmentBatchItem {
  return { size: meta.size, image: isAttachmentImageMediaType(meta.mediaType) };
}

/**
 * 大きいファイル（画像以外で `maxFileBytes` を超えるもの。外部ストレージが有効なときだけ在りうる）か。
 * 合計（`maxTotalBytes`）には数えず、個数（`maxPerMessage`）には数える。
 */
export function isLargeAttachment(
  item: AttachmentBatchItem,
  limits: Pick<AttachmentLimits, 'maxFileBytes'>,
): boolean {
  return isLargeAttachmentSize(limits, item.size, item.image);
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
  maxLargeFileBytes: 0,
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

/**
 * Bedrock / Vertex 経由のときの画像1枚の上限（raw バイト。#3743）。経路の上限は base64 で 5 MB
 * （https://platform.claude.com/docs/en/build-with-claude/vision 、直は 10 MB）。5 MB が 10 進か 2 進かは
 * 文書に書かれていないので、小さい 10 進（5,000,000）で読み、base64（×4/3）が収まる raw の最大にする。
 */
export const ATTACHMENT_MAX_IMAGE_BYTES_BASE64_ROUTE = 3_750_000;

const TRUTHY_ENV = new Set(['1', 'true', 'yes', 'on']);

/**
 * ターンを走らせる環境が Bedrock / Vertex 経由か（`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`。
 * `1` / `true` / `yes` / `on` を真と読む）。
 * **判定できない（未設定・空・読めない値）ときは `false`＝直の上限のまま。** 既定の経路は直で、
 * 判定に失敗したときに下げると、通常の経路の画像が理由なく渡らなくなる（能力の削除になる）。
 * 逆向きの誤りで経路の上限を超えても、API がその画像を拒むだけで済む。
 */
export function isBase64CappedImageRoute(env: NodeJS.ProcessEnv): boolean {
  return (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'] as const).some((name) =>
    TRUTHY_ENV.has((env[name] ?? '').trim().toLowerCase()),
  );
}

/** 経路の上限で `maxImageBytes` を下げる必要があるときだけ、その上限（raw バイト）。直、または既に小さいときは `undefined`。 */
export function routeImageCapBytes(
  limits: Pick<AttachmentLimits, 'maxImageBytes'>,
  env: NodeJS.ProcessEnv,
): number | undefined {
  return isBase64CappedImageRoute(env) &&
    limits.maxImageBytes > ATTACHMENT_MAX_IMAGE_BYTES_BASE64_ROUTE
    ? ATTACHMENT_MAX_IMAGE_BYTES_BASE64_ROUTE
    : undefined;
}

/** 経路の上限で外したときの通知行の括弧書き（#3743）。`openHint` は開け方。 */
export function imageRouteOverNotice(openHint: string): string {
  return `（この経路（Bedrock / Vertex）の画像1枚の上限（base64 で 5 MB）を超えるので画像としては渡していない。${openHint}）`;
}

/** ターンの画像の予算で外した理由（#3696）。`count` は枚数、`bytes` は合計。 */
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
      // 外部ストレージが有効なときだけ効く（無効・不正な設定なら 0＝枠なし）
      maxLargeFileBytes:
        readAttachmentBlobConfig(env).kind === 'on'
          ? read(ATTACHMENT_MAX_LARGE_FILE_BYTES_ENV, ATTACHMENT_MAX_LARGE_FILE_BYTES_DEFAULT)
          : 0,
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
  | 'too_large'
  | 'image_dimension_too_large'
  | 'magic_mismatch'
  | 'too_many'
  | 'total_too_large'
  | 'media_type_missing'
  | 'empty';

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
  // 切ったあとにも判定と trim をやり直す（やり直さないと、切り口に孤立した ZWJ・ZWNJ が残る。#3998）。
  // 文字を `_` にしても長さは増えない（ZWJ・ZWNJ は 3 バイト、`_` は 1 バイト）ので、上限は崩れない。
  const stem = sanitizeNameChars(
    truncateUtf8(
      ext === '' ? normalized : normalized.slice(0, dot),
      ATTACHMENT_DISK_NAME_MAX_BYTES - Buffer.byteLength(ext, 'utf8'),
    ),
  );
  return stem === '' || stem === '.' || stem === '..' ? `file${ext}` : `${stem}${ext}`;
}

/**
 * 1つぶんの検証。通れば正規化した名前と MIME を返す。
 * - 0バイト → `empty`（画像の宣言でも。Web・CLI・TUI と揃えて断る。#3327）
 * - 宣言 MIME が画像なのに中身が一致しない → `magic_mismatch`
 * - 画像は `maxImageBytes`、それ以外は `maxFileBytes` を超えると `too_large`
 * - 画像の宣言で、寸法が読めて幅か高さが {@link ATTACHMENT_MAX_IMAGE_DIMENSION} px を超えると
 *   `image_dimension_too_large`（#3697。読めない寸法は今までどおり通す）
 */
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
  const max = attachmentMaxBytes(limits, image);
  if (input.bytes.length > max) {
    throw new AttachmentRejectedError(
      'too_large',
      attachmentTooLargeMessage(image ? 'image' : 'file', input.bytes.length, max),
    );
  }
  if (image && sniffAttachmentImageType(input.bytes) !== mediaType) {
    throw new AttachmentRejectedError(
      'magic_mismatch',
      `宣言された ${mediaType} と中身の先頭が一致しない`,
    );
  }
  if (image) {
    const size = readAttachmentImageSize(input.bytes, mediaType);
    if (
      size !== undefined &&
      (size.width > ATTACHMENT_MAX_IMAGE_DIMENSION || size.height > ATTACHMENT_MAX_IMAGE_DIMENSION)
    ) {
      throw new AttachmentRejectedError(
        'image_dimension_too_large',
        `画像の寸法は幅・高さとも ${ATTACHMENT_MAX_IMAGE_DIMENSION} px まで（${size.width} × ${size.height} px ある）`,
      );
    }
  }
  return { name: normalizeAttachmentName(input.name), mediaType };
}

/**
 * 1発言（と担い手の1報告）の個数・合計の検査。
 *
 * **大きいファイル（{@link isLargeAttachment}）は合計に数えない**（個数には数える）。合計の上限は、bytea と base64 の本文が
 * 1度にメモリへ載る負荷を抑えるためのもので、外部ストレージの大きいファイルはストリームで流れるのでその負荷にならない（#4128 段2）。
 * 要素が数のときは、画像の別を知らない＝大きいファイルではないものとして、合計に数える。
 */
export function validateAttachmentBatch(
  items: readonly (AttachmentBatchItem | number)[],
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): void {
  if (items.length > limits.maxPerMessage) {
    throw new AttachmentRejectedError(
      'too_many',
      attachmentTooManyMessage(limits.maxPerMessage, items.length),
    );
  }
  const total = items.reduce<number>((sum, item) => {
    if (typeof item === 'number') return sum + item;
    return isLargeAttachment(item, limits) ? sum : sum + item.size;
  }, 0);
  if (total > limits.maxTotalBytes) {
    throw new AttachmentRejectedError(
      'total_too_large',
      attachmentTotalTooLargeMessage(limits.maxTotalBytes, total),
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
  return buildAttachmentMeta(
    input,
    { name, mediaType, size: input.bytes.length, sha256: sha256Hex(input.bytes) },
    limits,
    now,
  );
}

/**
 * 流して入れるときの、読み始める前の検査の結果（#4128 段1）。
 * `max` は {@link validateAttachmentInput} が最終的に掛けるのと同じ上限（画像は `maxImageBytes`、それ以外は `maxFileBytes`）。
 */
export interface AttachmentStreamPlan {
  readonly name: string;
  readonly mediaType: string;
  readonly image: boolean;
  readonly max: number;
}

/** 読み始める前の検査: mediaType が空なら断り、名前・mediaType の正規化と上限を決める。 */
export function planAttachmentStream(
  input: Pick<AttachmentPutStreamInput, 'name' | 'mediaType'>,
  limits: AttachmentLimits,
): AttachmentStreamPlan {
  const mediaType = normalizeAttachmentMediaType(input.mediaType);
  if (mediaType === '') {
    throw new AttachmentRejectedError('media_type_missing', 'mediaType が空');
  }
  const image = isAttachmentImageMediaType(mediaType);
  return {
    name: normalizeAttachmentName(input.name),
    mediaType,
    image,
    max: attachmentMaxBytes(limits, image),
  };
}

/**
 * 流しながら大きさと sha256 を数える部品（#4128 段1）。
 * 上限を超えた時点で `AttachmentRejectedError('too_large')` を投げる（文言は {@link put} と同じ。大きさは「そこまでに数えた分」）。
 */
export class AttachmentStreamMeter {
  readonly #plan: AttachmentStreamPlan;
  readonly #hash = createHash('sha256');
  #size = 0;

  constructor(plan: AttachmentStreamPlan) {
    this.#plan = plan;
  }

  write(chunk: Uint8Array): void {
    this.#size += chunk.length;
    if (this.#size > this.#plan.max) {
      throw new AttachmentRejectedError(
        'too_large',
        attachmentTooLargeMessage(this.#plan.image ? 'image' : 'file', this.#size, this.#plan.max),
      );
    }
    this.#hash.update(chunk);
  }

  /** 0 バイトなら `empty`。通れば大きさと sha256（hex）を返す。 */
  finish(): { size: number; sha256: string } {
    if (this.#size === 0) throw new AttachmentRejectedError('empty', ATTACHMENT_EMPTY_MESSAGE);
    return { size: this.#size, sha256: this.#hash.digest('hex') };
  }
}

/** 上限つきで全部集める（memory・pg と、fs の画像が使う）。超えた時点で読むのを止める。 */
export async function collectAttachmentStream(
  body: AsyncIterable<Uint8Array>,
  plan: AttachmentStreamPlan,
): Promise<Uint8Array> {
  const meter = new AttachmentStreamMeter(plan);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    meter.write(chunk);
    chunks.push(chunk);
  }
  meter.finish();
  return Buffer.concat(chunks);
}

/** 流し終えたあとの控え（fs が使う）。 */
export function prepareStreamedAttachment(
  input: AttachmentPutStreamInput,
  plan: AttachmentStreamPlan,
  done: { size: number; sha256: string },
  limits: AttachmentLimits,
  now: Date,
): AttachmentMeta {
  return buildAttachmentMeta(
    input,
    { name: plan.name, mediaType: plan.mediaType, ...done },
    limits,
    now,
  );
}

function buildAttachmentMeta(
  input: Pick<AttachmentPutInput, 'conversationId' | 'uploadedBy' | 'kept'>,
  fixed: { name: string; mediaType: string; size: number; sha256: string },
  limits: AttachmentLimits,
  now: Date,
): AttachmentMeta {
  if (input.conversationId !== undefined) assertNoNul('conversationId', input.conversationId);
  const { name, mediaType, size, sha256 } = fixed;
  return {
    id: randomUUID(),
    name,
    mediaType,
    size,
    sha256,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.uploadedBy === undefined || input.uploadedBy === ''
      ? {}
      : { uploadedBy: stripNul(input.uploadedBy) }),
    createdAt: now.toISOString(),
    // 保存中は期限を持たない（`keptAt` と `expiresAt` はどちらか一方だけ）
    ...(input.kept === true
      ? { keptAt: now.toISOString() }
      : { expiresAt: attachmentExpiryFrom(now, limits) }),
  };
}

/** 保持日数から数えた期限（作成時と、保存を外したときの両方がこれ）。 */
export function attachmentExpiryFrom(
  now: Date,
  limits: Pick<AttachmentLimits, 'retentionDays'>,
): string {
  return new Date(now.getTime() + limits.retentionDays * 86_400_000).toISOString();
}

/**
 * 保存の印を付けた／外したあとの控え（インメモリ・fs が使う。pg は同じ変更を UPDATE で書く）。
 * 付ける＝`keptAt = now`・`expiresAt` を外す。外す＝`keptAt` を外し `expiresAt = now + 保持日数`。
 * すでにその状態なら同じ控えをそのまま返す（`keptAt` を動かさない・期限を延ばさない）。
 */
export function withAttachmentKept(
  meta: AttachmentMeta,
  kept: boolean,
  now: Date,
  limits: Pick<AttachmentLimits, 'retentionDays'>,
): AttachmentMeta {
  if ((meta.keptAt !== undefined) === kept) return meta;
  const next: { -readonly [K in keyof AttachmentMeta]: AttachmentMeta[K] } = { ...meta };
  delete next.keptAt;
  delete next.expiresAt;
  // 付け直したら外した印は要らない。外したら、未結び付け1時間の対象から外すために時刻を残す
  delete next.releasedAt;
  if (kept) next.keptAt = now.toISOString();
  else {
    next.expiresAt = attachmentExpiryFrom(now, limits);
    next.releasedAt = now.toISOString();
  }
  return next;
}

/**
 * 期限（`expiresAt`）を過ぎているか（ちょうどの瞬間も過ぎたと数える）。**3実装の `get` / `getMeta` / `bind` /
 * `bindToExternalEvent` は、これが真のものを「無い」と扱う**（#3522。prune が走る前でも読めず・結べない。
 * 結んだ発言の添付が、あとの prune で黙って消えるのを防ぐ）。{@link isAttachmentPrunable} の期限の条件と同じ。
 * **保存中（`keptAt` がある・期限を持たない）は過ぎない**（#4126 P4）。pg は同じ条件を SQL で書く。
 */
export function isAttachmentExpired(meta: AttachmentMeta, now: Date): boolean {
  if (meta.keptAt !== undefined || meta.expiresAt === undefined) return false;
  return Date.parse(meta.expiresAt) <= now.getTime();
}

/** 掃除の対象か（インメモリ・fs が使う。pg は同じ条件を SQL で書く）。**保存中は期限でも未結び付けでも対象にならない。** */
export function isAttachmentPrunable(meta: AttachmentMeta, now: Date): boolean {
  if (meta.keptAt !== undefined) return false;
  if (isAttachmentExpired(meta, now)) return true;
  // 未結び付け1時間は「上げただけで使わなかった残骸」の規則。一度保存されたもの（外したもの）には掛けない
  return (
    meta.releasedAt === undefined &&
    !isAttachmentBound(meta) &&
    Date.parse(meta.createdAt) + ATTACHMENT_UNBOUND_TTL_MS <= now.getTime()
  );
}

/** 結び付け先。**会話・外部イベント・マネージャーの報告のどれか1つ**（{@link AttachmentMeta.managerReportId}）。 */
export type AttachmentBindTarget =
  { conversationId: string } | { externalEventId: string } | { managerReportId: string };

/** 結び付け先の種類を表す、{@link AttachmentMeta} の欄の名前。 */
export type AttachmentBindKey = 'conversationId' | 'externalEventId' | 'managerReportId';

export const ATTACHMENT_BIND_KEYS: readonly AttachmentBindKey[] = [
  'conversationId',
  'externalEventId',
  'managerReportId',
];

/** `target` がどの欄へ結ぶものか。 */
export function attachmentBindKeyOf(target: AttachmentBindTarget): AttachmentBindKey {
  if ('conversationId' in target) return 'conversationId';
  if ('externalEventId' in target) return 'externalEventId';
  return 'managerReportId';
}

/** `target` の値（会話の id・外部イベントの id・報告の id）。 */
export function attachmentBindValueOf(target: AttachmentBindTarget): string {
  return (target as Record<AttachmentBindKey, string>)[attachmentBindKeyOf(target)];
}

/** どこかの宛先に結び付いているか（未結び付けの掃除・「別の宛先に結び付いた添付は使えない」の判定に使う）。 */
export function isAttachmentBound(meta: AttachmentMeta): boolean {
  return ATTACHMENT_BIND_KEYS.some((key) => meta[key] !== undefined);
}

export function isBoundTo(meta: AttachmentMeta, target: AttachmentBindTarget): boolean {
  return meta[attachmentBindKeyOf(target)] === attachmentBindValueOf(target);
}

/**
 * いま `target` へ結んでよいか（3実装が同じ規則を使う。pg は同じ条件を SQL で書く）。
 * 未結び付けか、**同じ宛先**のときだけ真。別の会話・別の外部イベント・別の報告・種類の違う宛先なら偽（conflict）。
 */
export function canBindAttachmentTo(meta: AttachmentMeta, target: AttachmentBindTarget): boolean {
  const key = attachmentBindKeyOf(target);
  return ATTACHMENT_BIND_KEYS.every((other) =>
    other === key
      ? (meta[other] ?? attachmentBindValueOf(target)) === attachmentBindValueOf(target)
      : meta[other] === undefined,
  );
}

/** 結び付け先の呼び名（結び付けを戻せなかったときの注意書きに使う）。 */
export function attachmentBindTargetLabel(target: AttachmentBindTarget): string {
  const key = attachmentBindKeyOf(target);
  return key === 'conversationId'
    ? '会話'
    : key === 'externalEventId'
      ? '外部イベント'
      : 'マネージャーの報告';
}
