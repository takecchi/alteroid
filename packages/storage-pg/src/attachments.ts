import {
  ATTACHMENT_UNBOUND_TTL_MS,
  assertNoNul,
  attachmentBindKeyOf,
  attachmentBindTargetLabel,
  attachmentExpiryFrom,
  decodeAttachmentCursor,
  emptyAttachmentUsage,
  encodeAttachmentCursor,
  hasNul,
  prepareAttachment,
  readAttachmentLimits,
  reasonOf,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentFromClass,
  type AttachmentListPage,
  type AttachmentListQuery,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentStore,
  type AttachmentStoreOptions,
  type AttachmentUsage,
} from '@alteroid/core';
import {
  and,
  desc,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notLike,
  or,
  eq,
  gt,
  like,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from './db.js';
import { byteOrder, toIso, toNumber } from './db.js';
import { attachments } from './schema.js';

const META_COLUMNS = {
  id: attachments.id,
  sha256: attachments.sha256,
  mediaType: attachments.mediaType,
  name: attachments.name,
  size: attachments.size,
  conversationId: attachments.conversationId,
  externalEventId: attachments.externalEventId,
  managerReportId: attachments.managerReportId,
  uploadedBy: attachments.uploadedBy,
  createdAt: attachments.createdAt,
  expiresAt: attachments.expiresAt,
  keptAt: attachments.keptAt,
} as const;

interface MetaRow {
  id: string;
  sha256: string;
  mediaType: string;
  name: string;
  size: number | string;
  conversationId: string | null;
  externalEventId: string | null;
  managerReportId: string | null;
  uploadedBy: string | null;
  createdAt: Date | string;
  expiresAt: Date | string | null;
  keptAt: Date | string | null;
}

function toMeta(row: MetaRow): AttachmentMeta {
  return {
    id: row.id,
    name: row.name,
    mediaType: row.mediaType,
    size: toNumber(row.size),
    sha256: row.sha256,
    ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
    ...(row.externalEventId === null ? {} : { externalEventId: row.externalEventId }),
    ...(row.managerReportId === null ? {} : { managerReportId: row.managerReportId }),
    ...(row.uploadedBy === null ? {} : { uploadedBy: row.uploadedBy }),
    createdAt: toIso(row.createdAt),
    ...(row.expiresAt === null ? {} : { expiresAt: toIso(row.expiresAt) }),
    ...(row.keptAt === null ? {} : { keptAt: toIso(row.keptAt) }),
  };
}

/**
 * 出所の分類（core の `classifyAttachmentFrom` と同じ規則を SQL で書く）。`like` の接頭辞に `_` と `%` は含まれない。
 */
function fromCondition(from: AttachmentFromClass): SQL {
  const uploadedBy = attachments.uploadedBy;
  const human = or(eq(uploadedBy, 'operator'), like(uploadedBy, 'account:%'));
  const clone = eq(uploadedBy, 'clone');
  const manager = like(uploadedBy, 'manager:%');
  const integration = like(uploadedBy, 'integration:%');
  switch (from) {
    case 'human':
      return human!;
    case 'clone':
      return clone;
    case 'manager':
      return manager;
    case 'integration':
      return integration;
    case 'unknown':
      return or(
        isNull(uploadedBy),
        and(
          ne(uploadedBy, 'operator'),
          notLike(uploadedBy, 'account:%'),
          ne(uploadedBy, 'clone'),
          notLike(uploadedBy, 'manager:%'),
          notLike(uploadedBy, 'integration:%'),
        ),
      )!;
  }
}

/** 使用量を出所ごとに数える SQL の分類式（`fromCondition` と同じ規則。値を埋め込まないので group by に同じ式を渡せる）。 */
const FROM_CLASS_EXPR = sql<AttachmentFromClass>`case
  when ${attachments.uploadedBy} = 'operator' or ${attachments.uploadedBy} like 'account:%' then 'human'
  when ${attachments.uploadedBy} = 'clone' then 'clone'
  when ${attachments.uploadedBy} like 'manager:%' then 'manager'
  when ${attachments.uploadedBy} like 'integration:%' then 'integration'
  else 'unknown'
end`;

export class PgAttachmentStore implements AttachmentStore {
  readonly #db: Db;
  readonly #options: AttachmentStoreOptions;

  constructor(db: Db, options: AttachmentStoreOptions = {}) {
    this.#db = db;
    this.#options = options;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  /** core の `isAttachmentExpired` と同じ条件（保存中・期限を持たないものは期限切れにならない）。 */
  #notExpiredAt(now: Date) {
    return or(isNotNull(attachments.keptAt), isNull(attachments.expiresAt), gt(attachments.expiresAt, now))!;
  }

  #notExpired() {
    return this.#notExpiredAt(this.#now());
  }

  async put(input: AttachmentPutInput): Promise<AttachmentMeta> {
    const limits = this.#options.limits ?? readAttachmentLimits().limits;
    const meta = prepareAttachment(input, limits, this.#options.now?.() ?? new Date());
    await this.#db.insert(attachments).values({
      id: meta.id,
      sha256: meta.sha256,
      mediaType: meta.mediaType,
      name: meta.name,
      size: meta.size,
      bytes: Buffer.from(input.bytes),
      conversationId: meta.conversationId ?? null,
      externalEventId: meta.externalEventId ?? null,
      uploadedBy: meta.uploadedBy ?? null,
      createdAt: new Date(meta.createdAt),
      expiresAt: meta.expiresAt === undefined ? null : new Date(meta.expiresAt),
      keptAt: meta.keptAt === undefined ? null : new Date(meta.keptAt),
    });
    return meta;
  }

  async get(id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | undefined> {
    if (hasNul(id)) return undefined;
    const rows = await this.#db
      .select({ ...META_COLUMNS, bytes: attachments.bytes })
      .from(attachments)
      .where(and(eq(attachments.id, id), this.#notExpired()));
    const row = rows[0];
    if (row === undefined) return undefined;
    return { meta: toMeta(row), bytes: new Uint8Array(row.bytes) };
  }

  async getMeta(id: string): Promise<AttachmentMeta | undefined> {
    if (hasNul(id)) return undefined;
    const rows = await this.#db
      .select(META_COLUMNS)
      .from(attachments)
      .where(and(eq(attachments.id, id), this.#notExpired()));
    return rows[0] === undefined ? undefined : toMeta(rows[0]);
  }

  async bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult> {
    assertNoNul('conversationId', conversationId);
    return this.#bindTo(ids, { conversationId });
  }

  async bindToExternalEvent(
    ids: readonly string[],
    eventId: string,
  ): Promise<AttachmentBindResult> {
    assertNoNul('eventId', eventId);
    return this.#bindTo(ids, { externalEventId: eventId });
  }

  async bindToManagerReport(
    ids: readonly string[],
    reportId: string,
  ): Promise<AttachmentBindResult> {
    assertNoNul('reportId', reportId);
    return this.#bindTo(ids, { managerReportId: reportId });
  }

  async #bindTo(
    ids: readonly string[],
    target: AttachmentBindTarget,
  ): Promise<AttachmentBindResult> {
    const queryable = [...new Set(ids.filter((id) => !hasNul(id)))];
    const bound = new Set<string>();
    const newlyBound = new Set<string>();
    const conflicts = new Set<string>();
    if (queryable.length > 0) {
      // 読んでから更新しない: 1本の UPDATE … RETURNING にして、同時に先に結ばれた行が WHERE に当たらないようにするため。
      const notExpired = this.#notExpired();
      const updated = await this.#db
        .update(attachments)
        .set(target)
        .where(
          and(
            inArray(attachments.id, queryable),
            isNull(attachments.conversationId),
            isNull(attachments.externalEventId),
            isNull(attachments.managerReportId),
            notExpired,
          ),
        )
        .returning({ id: attachments.id });
      for (const row of updated) {
        bound.add(row.id);
        newlyBound.add(row.id);
      }
      const rest = queryable.filter((id) => !bound.has(id));
      if (rest.length > 0) {
        // SELECT が落ちたら新しく結んだ分を戻して投げ直す: 呼び手には `newlyBound` が届かないため。
        const others = await this.#db
          .select({
            id: attachments.id,
            conversationId: attachments.conversationId,
            externalEventId: attachments.externalEventId,
            managerReportId: attachments.managerReportId,
          })
          .from(attachments)
          .where(and(inArray(attachments.id, rest), notExpired))
          .catch(async (error: unknown) => {
            await this.unbind([...newlyBound], target).catch((rollbackError: unknown) => {
              process.stderr.write(
                `alteroidd: 添付の結び付けを戻せなかった（${attachmentBindTargetLabel(target)}へ結んだ ${newlyBound.size} 件が残る）: ${reasonOf(rollbackError)}\n`,
              );
            });
            throw error;
          });
        for (const row of others) {
          const key = attachmentBindKeyOf(target);
          const same = (['conversationId', 'externalEventId', 'managerReportId'] as const).every(
            (column) =>
              column === key
                ? row[column] === (target as Record<typeof key, string>)[key]
                : row[column] === null,
          );
          (same ? bound : conflicts).add(row.id);
        }
      }
    }
    return {
      bound: ids.filter((id) => bound.has(id)),
      newlyBound: ids.filter((id, index) => newlyBound.has(id) && ids.indexOf(id) === index),
      missing: ids.filter((id) => !bound.has(id) && !conflicts.has(id)),
      conflicts: ids.filter((id) => conflicts.has(id)),
    };
  }

  async unbind(ids: readonly string[], target: AttachmentBindTarget): Promise<string[]> {
    const queryable = [...new Set(ids.filter((id) => !hasNul(id)))];
    if (queryable.length === 0) return [];
    const updated = await this.#db
      .update(attachments)
      .set(
        'conversationId' in target
          ? { conversationId: null }
          : 'externalEventId' in target
            ? { externalEventId: null }
            : { managerReportId: null },
      )
      .where(
        and(
          inArray(attachments.id, queryable),
          'conversationId' in target
            ? eq(attachments.conversationId, target.conversationId)
            : 'externalEventId' in target
              ? eq(attachments.externalEventId, target.externalEventId)
              : eq(attachments.managerReportId, target.managerReportId),
        ),
      )
      .returning({ id: attachments.id });
    const done = new Set(updated.map((row) => row.id));
    return queryable.filter((id) => done.has(id));
  }

  async prune(now: Date): Promise<number> {
    const unboundBefore = new Date(now.getTime() - ATTACHMENT_UNBOUND_TTL_MS);
    const removed = await this.#db
      .delete(attachments)
      .where(
        and(
          // 保存中は期限でも未結び付けでも消さない（#4126 P4）
          isNull(attachments.keptAt),
          or(
            lte(attachments.expiresAt, now),
            and(
              isNull(attachments.conversationId),
              isNull(attachments.externalEventId),
              isNull(attachments.managerReportId),
              lte(attachments.createdAt, unboundBefore),
            ),
          ),
        ),
      )
      .returning({ id: attachments.id });
    return removed.length;
  }

  async setKept(id: string, kept: boolean, now: Date): Promise<AttachmentMeta | undefined> {
    if (hasNul(id)) return undefined;
    const limits = this.#options.limits ?? readAttachmentLimits().limits;
    // 読んでから更新しない: 1本の UPDATE … RETURNING で、期限切れ・すでに同じ状態の行には当てない
    const updated = await this.#db
      .update(attachments)
      .set(
        kept
          ? { keptAt: now, expiresAt: null }
          : { keptAt: null, expiresAt: new Date(attachmentExpiryFrom(now, limits)) },
      )
      .where(
        and(
          eq(attachments.id, id),
          kept ? isNull(attachments.keptAt) : isNotNull(attachments.keptAt),
          this.#notExpiredAt(now),
        ),
      )
      .returning(META_COLUMNS);
    if (updated[0] !== undefined) return toMeta(updated[0]);
    const rows = await this.#db
      .select(META_COLUMNS)
      .from(attachments)
      .where(and(eq(attachments.id, id), this.#notExpiredAt(now)));
    return rows[0] === undefined ? undefined : toMeta(rows[0]);
  }

  async remove(id: string): Promise<boolean> {
    if (hasNul(id)) return false;
    const removed = await this.#db
      .delete(attachments)
      .where(eq(attachments.id, id))
      .returning({ keptAt: attachments.keptAt, expiresAt: attachments.expiresAt });
    const row = removed[0];
    if (row === undefined) return false;
    return row.keptAt !== null || row.expiresAt === null || new Date(row.expiresAt) > this.#now();
  }

  async list(query: AttachmentListQuery): Promise<AttachmentListPage> {
    const after = query.cursor === undefined ? undefined : decodeAttachmentCursor(query.cursor);
    const limit = Math.max(1, Math.floor(query.limit));
    const afterAt = after === undefined ? undefined : new Date(after.createdAt);
    const conditions = [
      this.#notExpired(),
      query.kept === undefined
        ? undefined
        : query.kept
          ? isNotNull(attachments.keptAt)
          : isNull(attachments.keptAt),
      query.from === undefined ? undefined : fromCondition(query.from),
      query.conversationId === undefined
        ? undefined
        : eq(attachments.conversationId, query.conversationId),
      // 位置で探す: LIKE だと `%` `_` のエスケープが要り、利用者の入力をそのまま渡せない
      query.q === undefined || query.q === ''
        ? undefined
        : sql`position(lower(${query.q}) in lower(${attachments.name})) > 0`,
      after === undefined || afterAt === undefined
        ? undefined
        : or(
            lt(attachments.createdAt, afterAt),
            and(
              eq(attachments.createdAt, afterAt),
              sql`${byteOrder(attachments.id)} < ${after.id}`,
            ),
          ),
    ];
    const rows = await this.#db
      .select(META_COLUMNS)
      .from(attachments)
      .where(and(...conditions))
      .orderBy(desc(attachments.createdAt), desc(byteOrder(attachments.id)))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toMeta);
    return rows.length > limit
      ? { items, nextCursor: encodeAttachmentCursor(items[items.length - 1]!) }
      : { items };
  }

  async usage(): Promise<AttachmentUsage> {
    const rows = await this.#db
      .select({
        from: FROM_CLASS_EXPR,
        count: sql<number | string>`count(*)`,
        totalBytes: sql<number | string>`coalesce(sum(${attachments.size}), 0)`,
      })
      .from(attachments)
      .where(this.#notExpired())
      .groupBy(FROM_CLASS_EXPR);
    const usage = emptyAttachmentUsage();
    for (const row of rows) {
      const bucket = usage.byFrom[row.from];
      bucket.count = toNumber(row.count);
      bucket.totalBytes = toNumber(row.totalBytes);
      usage.count += bucket.count;
      usage.totalBytes += bucket.totalBytes;
    }
    return usage;
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(attachments).returning({ id: attachments.id });
    return removed.length;
  }
}
