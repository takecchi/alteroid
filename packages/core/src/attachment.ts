import { randomUUID } from 'node:crypto';

import {
  ATTACHMENT_MAX_IMAGE_DIMENSION,
  readAttachmentImageSize,
} from './attachment-image-size.js';
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
  /** 正規化済みのファイル名（パス区切りを含まない）。 */
  readonly name: string;
  /** 宣言された MIME（小文字・パラメータ除去済み）。 */
  readonly mediaType: string;
  /** バイト数。 */
  readonly size: number;
  /** 中身の SHA-256（16進）。core が計算する。 */
  readonly sha256: string;
  /** 結び付けた会話。未結び付けなら無い。 */
  readonly conversationId?: string;
  /**
   * 結び付けた外部イベントの id（#3113 段3）。**結び付け先は会話か外部イベントのどちらか1つ**
   * （{@link AttachmentStore.bindToExternalEvent}）。未結び付けなら無い。
   */
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
  /** ISO 8601。 */
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
  /** 上げた主体の識別子（任意。{@link AttachmentMeta.uploadedBy}）。 */
  readonly uploadedBy?: string;
}

export interface AttachmentBindResult {
  /** 結び付いた id（すでに同じ会話へ結び付いていた id も含む）。 */
  readonly bound: string[];
  /**
   * `bound` のうち、**この呼び出しで新しく結んだ**id（呼ぶ前は未結び付けだったもの）。すでに同じ宛先へ結ばれていた id
   * （前の発言や、同時に届いた別の呼び出しが先に結んだもの）は含まない。判定は実装が、結ぶのと同じ原子的な操作の中で行う
   * （#3282。呼び手が先に `getMeta` で見た状態は、`bind` までの間に変わりうる）。断るときに `unbind` してよいのはこれだけ。
   */
  readonly newlyBound: string[];
  /** 無かった（消えた・期限切れ・NUL を含む）id。 */
  readonly missing: string[];
  /** すでに**別の**会話へ結び付いていたので触らなかった id。 */
  readonly conflicts: string[];
}

export interface AttachmentStore {
  /**
   * 預かる。ファイル名の正規化・MIME の正規化・マジックバイトと上限の検証・SHA-256 の計算・id の払い出しは
   * ここで行う（3実装で同じ {@link prepareAttachment}）。検証に落ちたら {@link AttachmentRejectedError}。
   */
  put(input: AttachmentPutInput): Promise<AttachmentMeta>;
  /** 控えと中身。無ければ `undefined`。 */
  get(id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | undefined>;
  /** 控えだけ。**中身を読まない**（pg は bytes 列を SELECT しない）。 */
  getMeta(id: string): Promise<AttachmentMeta | undefined>;
  /**
   * 発言（会話）へ結び付ける。未結び付けの掃除の判定に使う。冪等。
   * **すでに別の会話・外部イベントへ結び付いていたものは `conflicts`**（触らない）。
   */
  bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult>;
  /**
   * 外部イベント（受信箱の `external` の id）へ結び付ける（#3113 段3）。{@link bind} と同じ規則で、
   * 冪等・別の宛先（会話、別の外部イベント）に結び付いていたものは `conflicts`・無いものは `missing`。
   * 結び付いたものは {@link isAttachmentPrunable} の「未結び付け」に数えない。
   */
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
  /**
   * 掃除。①`expiresAt` を過ぎたもの、②作成から {@link ATTACHMENT_UNBOUND_TTL_MS} たっても未結び付けのもの、を消す。
   * 消した件数を返す。**中身を読まない。**
   */
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

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

export const ATTACHMENT_MAX_IMAGE_BYTES_DEFAULT = 5 * MIB;
export const ATTACHMENT_MAX_FILE_BYTES_DEFAULT = 25 * MIB;
export const ATTACHMENT_MAX_PER_MESSAGE_DEFAULT = 10;
export const ATTACHMENT_MAX_TOTAL_BYTES_DEFAULT = 50 * MIB;
export const ATTACHMENT_RETENTION_DAYS_DEFAULT = 30;
/** 1ターン（担い手なら1メッセージ）で画像として渡す枚数の既定（#3696。API は 20 枚を超えると全画像に 2000px の制限を掛ける）。 */
export const ATTACHMENT_MAX_TURN_IMAGES_DEFAULT = 20;
/** 1ターンで画像として渡す合計 raw バイトの既定（#3696。base64 で約 21.4 MB。API の 1 リクエスト 32 MB に収める）。 */
export const ATTACHMENT_MAX_TURN_IMAGE_BYTES_DEFAULT = 16 * MIB;
/**
 * 保持日数の上限（約100年）。`expiresAt` は `new Date(now + 日数 × 86_400_000).toISOString()` で作るので、
 * 巨大な値は `RangeError: Invalid time value` で全 `put` を 500 にする（Issue #3326）。
 */
export const ATTACHMENT_RETENTION_DAYS_MAX = 36_500;
/** 未結び付けのまま残してよい時間（作成から。1時間）。 */
export const ATTACHMENT_UNBOUND_TTL_MS = 60 * 60_000;

export const ATTACHMENT_MAX_IMAGE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_IMAGE_BYTES';
export const ATTACHMENT_MAX_FILE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_FILE_BYTES';
export const ATTACHMENT_MAX_PER_MESSAGE_ENV = 'ALTEROID_ATTACHMENT_MAX_PER_MESSAGE';
export const ATTACHMENT_MAX_TOTAL_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_TOTAL_BYTES';
export const ATTACHMENT_RETENTION_DAYS_ENV = 'ALTEROID_ATTACHMENT_RETENTION_DAYS';
export const ATTACHMENT_MAX_TURN_IMAGES_ENV = 'ALTEROID_ATTACHMENT_MAX_TURN_IMAGES';
export const ATTACHMENT_MAX_TURN_IMAGE_BYTES_ENV = 'ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES';

export interface AttachmentLimits {
  /** 画像（png / jpeg / webp / gif）1つ。 */
  readonly maxImageBytes: number;
  /** その他（動画・ファイル）1つ。 */
  readonly maxFileBytes: number;
  /** 1発言の個数。 */
  readonly maxPerMessage: number;
  /** 1発言の合計バイト数。 */
  readonly maxTotalBytes: number;
  /** 保持日数。 */
  readonly retentionDays: number;
}

/**
 * ターンの画像の予算（#3696）。**{@link AttachmentLimits}（入口の検査の上限。`GET /attachments/limits` の形）とは
 * 型を分けてある**: 受け付け・保存を妨げず、ターン時に画像として渡すかどうかだけを決めるので、クライアントは知らなくてよい。
 */
export interface TurnImageLimits {
  /** 1ターン（担い手なら1メッセージ）で画像として渡す枚数。超えた分は通知行で開け方を言う。 */
  readonly maxTurnImages: number;
  /** 1ターンで画像として渡す合計 raw バイト。 */
  readonly maxTurnImageBytes: number;
}

/** ターンの画像の予算を使う側（クローン・担い手）が受ける上限。欄が無ければ既定を使う。 */
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

/** 上限からターンの画像の予算を取り出す（欄が無ければ既定）。 */
export function turnImageLimitsOf(limits: Partial<TurnImageLimits>): TurnImageLimits {
  return {
    maxTurnImages: limits.maxTurnImages ?? DEFAULT_TURN_IMAGE_LIMITS.maxTurnImages,
    maxTurnImageBytes: limits.maxTurnImageBytes ?? DEFAULT_TURN_IMAGE_LIMITS.maxTurnImageBytes,
  };
}

/**
 * 画像の上限を人間向けの文にする（MiB で割り切れれば `5 MiB`、そうでなければ `1000 B`）。
 * 中身が画像でも上限を超える添付を画像として渡さないときの通知行に使う（#3325）。
 */
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

/**
 * 1ターン（担い手なら1メッセージ）の画像の予算（#3696）。`take` を呼ぶ順が「枠に入れる優先順」になる。
 * 入ったものだけが枠を使う（外したものは使わない。1枚の上限（#3325）で外したものは、そもそも `take` を呼ばない）。
 * 枚数を先に見る。枠に入らなかったものがあっても、あとの小さいものは枠に残りがあれば入る。
 */
export class TurnImageBudget {
  #count = 0;
  #bytes = 0;
  readonly #limits: TurnImageLimits;

  constructor(limits: Partial<TurnImageLimits>) {
    this.#limits = turnImageLimitsOf(limits);
  }

  /** 枠に入るなら使って `undefined`。入らないなら理由（枠は使わない）。 */
  take(size: number): TurnImageOverReason | undefined {
    if (this.#count + 1 > this.#limits.maxTurnImages) return 'count';
    if (this.#bytes + size > this.#limits.maxTurnImageBytes) return 'bytes';
    this.#count += 1;
    this.#bytes += size;
    return undefined;
  }
}

/**
 * ターンの画像の予算で外した理由を、通知行の末尾の括弧書きにする（#3696）。`openHint` は開け方
 * （クローンは `attachment_fetch で取り出して Read で開ける`、担い手は `path で Read で開ける`）。
 */
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
  /** 読めなかった設定値についての注意（呼び出し元が人間に見せる）。 */
  readonly notes: string[];
}

/**
 * 環境変数から上限を読む（`readArchiveFoldConfig` と同じ作法: 読めない値は `notes` へ落として既定へ倒す）。
 * 正の整数だけを受ける。保持日数は {@link ATTACHMENT_RETENTION_DAYS_MAX} まで（超えたら既定へ倒す）。
 */
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

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

export type AttachmentRejection =
  | 'too_large'
  | 'image_dimension_too_large'
  | 'magic_mismatch'
  | 'too_many'
  | 'total_too_large'
  | 'media_type_missing'
  | 'empty';

/** 0バイトの添付を断る文（Web の `checkAttachments` と同じ文。#3327）。 */
export const ATTACHMENT_EMPTY_MESSAGE = '空のファイルは添えられない';

/** 添付を受け付けない理由。型で見分ける（文言で見分けない）。 */
export class AttachmentRejectedError extends Error {
  readonly code: AttachmentRejection;

  constructor(code: AttachmentRejection, message: string) {
    super(message);
    this.name = 'AttachmentRejectedError';
    this.code = code;
  }
}

/** マジックバイトで中身を確かめる画像の MIME。 */
export const ATTACHMENT_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AttachmentImageMediaType = (typeof ATTACHMENT_IMAGE_MEDIA_TYPES)[number];

/** `Content-Type` 風の宣言を、小文字・パラメータ除去の形へ。 */
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

/**
 * 中身の先頭で画像の種類を判定する（png / jpeg / webp / gif。手書き。依存なし）。
 * どれにも当たらなければ `undefined`。
 */
export function sniffAttachmentImageType(bytes: Uint8Array): AttachmentImageMediaType | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // "GIF87a" / "GIF89a"
  if (
    startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  // "RIFF" <size 4 bytes> "WEBP"
  if (
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp';
  }
  return undefined;
}

/** `String.prototype.toWellFormed`（ES2024）。tsconfig の `lib` が ES2023 なので最小の型だけ足す。 */
function toWellFormed(value: string): string {
  return (value as string & { toWellFormed(): string }).toWellFormed();
}

/** 保存するファイル名の長さの上限（UTF-16 コード単位）。 */
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

/**
 * ファイル名の正規化。NUL を落とし、孤立サロゲートを U+FFFD に変え（`stripNulls` と同じ規則）、
 * 制御文字（C0・DEL・C1）・書式制御文字（`\p{Cf}`。双方向制御・ゼロ幅など。表示の偽装に使われる）・パス区切り（`/` `\`）を `_` にし、前後の空白を除く。`.` / `..` / 空は `file` にする。
 * ただし ZWJ・ZWNJ は、文脈上正当なもの（Virama の後・アラビア文字などのあいだの ZWNJ・絵文字の連結）だけ残す（#3882）。
 */
export function normalizeAttachmentName(raw: string): string {
  let name = sanitizeNameChars(stripNul(raw));
  if (name.length > ATTACHMENT_NAME_MAX_LENGTH) {
    // 切ったあとにも判定と trim をやり直す（やり直さないと、切り口に残った ZWJ や末尾の空白が、
    // もう一度通したときに変わる）。
    name = sanitizeNameChars(name.slice(0, ATTACHMENT_NAME_MAX_LENGTH));
  }
  return name === '' || name === '.' || name === '..' ? 'file' : name;
}

/** ディスク上のパスに使う名前の長さの上限（UTF-8 のバイト数）。NAME_MAX（255）に余裕を残す。 */
export const ATTACHMENT_DISK_NAME_MAX_BYTES = 200;

/** 拡張子として残す長さの上限（`.` を含む UTF-8 のバイト数）。これより長い「拡張子」は拡張子とみなさない。 */
const ATTACHMENT_DISK_EXT_MAX_BYTES = 32;

/** `text` を UTF-8 で `maxBytes` バイト以内に、コードポイントの途中で切らずに丸める。 */
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

/**
 * ディスク上のパス（写し・担い手の置き場）に使う名前。{@link normalizeAttachmentName} を通したうえで、
 * UTF-8 で {@link ATTACHMENT_DISK_NAME_MAX_BYTES} バイト以内に丸める（Linux の NAME_MAX は 255 **バイト**。
 * 正規化は UTF-16 の 255 単位までなので、日本語の名前は 86 文字ほどで超える。Issue #3324）。拡張子は残し、
 * コードポイントの途中では切らない。**表示や控え（`AttachmentMeta.name`・通知行）には使わない**。
 */
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
  const max = image ? limits.maxImageBytes : limits.maxFileBytes;
  if (input.bytes.length > max) {
    throw new AttachmentRejectedError(
      'too_large',
      `${image ? '画像' : 'ファイル'}は 1 つ ${formatImageLimit(max)} まで（${input.bytes.length} バイトある）`,
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
 * 1発言ぶんの検証（個数・合計）。`sizes` は発言に添える全添付のバイト数。
 * 1つぶんは {@link validateAttachmentInput} が見る。
 */
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

// ---------------------------------------------------------------------------
// 3実装が共有する組み立て
// ---------------------------------------------------------------------------

/** ストア実装が受ける共通の設定。 */
export interface AttachmentStoreOptions {
  /** 既定は {@link readAttachmentLimits}（環境変数）。 */
  readonly limits?: AttachmentLimits;
  /** テスト用。既定は `() => new Date()`。 */
  readonly now?: () => Date;
}

/** `put` の前半（検証・id・sha256・期限）。3実装が同じ結果を作るようここへ置く。 */
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

/** いま `target` に結び付いているか（{@link AttachmentStore.unbind} が戻してよい id の判定。3実装が同じ規則を使う）。 */
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
