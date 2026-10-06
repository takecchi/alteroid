import {
  ATTACHMENT_UNBOUND_TTL_MS,
  assertNoNul,
  hasNul,
  prepareAttachment,
  readAttachmentLimits,
  reasonOf,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from '@alteroid/core';
import { and, inArray, isNull, lte, or, eq, gt } from 'drizzle-orm';

import type { Db } from './db.js';
import { toIso, toNumber } from './db.js';
import { attachments } from './schema.js';

/** `bytes` を含まない列。`getMeta` はこれだけを SELECT する。 */
const META_COLUMNS = {
  id: attachments.id,
  sha256: attachments.sha256,
  mediaType: attachments.mediaType,
  name: attachments.name,
  size: attachments.size,
  conversationId: attachments.conversationId,
  externalEventId: attachments.externalEventId,
  uploadedBy: attachments.uploadedBy,
  createdAt: attachments.createdAt,
  expiresAt: attachments.expiresAt,
} as const;

interface MetaRow {
  id: string;
  sha256: string;
  mediaType: string;
  name: string;
  size: number | string;
  conversationId: string | null;
  externalEventId: string | null;
  uploadedBy: string | null;
  createdAt: Date | string;
  expiresAt: Date | string;
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
    ...(row.uploadedBy === null ? {} : { uploadedBy: row.uploadedBy }),
    createdAt: toIso(row.createdAt),
    expiresAt: toIso(row.expiresAt),
  };
}

/**
 * 添付ファイルの置き場（pg。#3111 段1a）。契約は `packages/core/src/attachment-contract.ts`。
 *
 * **`getMeta` と `prune` は `bytes` 列を読まない**（`getMeta` は `META_COLUMNS` だけを SELECT、
 * `prune` は `DELETE ... RETURNING id`）。
 */
export class PgAttachmentStore implements AttachmentStore {
  readonly #db: Db;
  readonly #options: AttachmentStoreOptions;

  constructor(db: Db, options: AttachmentStoreOptions = {}) {
    this.#db = db;
    this.#options = options;
  }

  /** 期限内（`expiresAt` が今より後）。prune の `lte(expiresAt, now)` の逆で、ちょうどは期限切れ（#3522）。 */
  #notExpired() {
    return gt(attachments.expiresAt, this.#options.now?.() ?? new Date());
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
      expiresAt: new Date(meta.expiresAt),
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

  /** 結び付け先は会話か外部イベントのどちらか1つ（`canBindAttachmentTo` と同じ規則を SQL で書く）。 */
  async #bindTo(
    ids: readonly string[],
    target: AttachmentBindTarget,
  ): Promise<AttachmentBindResult> {
    const queryable = [...new Set(ids.filter((id) => !hasNul(id)))];
    const bound = new Set<string>();
    const newlyBound = new Set<string>();
    const conflicts = new Set<string>();
    if (queryable.length > 0) {
      // 1本の UPDATE … RETURNING が、行ごとの原子的な判定になる: 「いま未結び付け」の行だけがここで変わって返る。
      // 同時に別の呼び出しが先に結んだ行は WHERE に当たらない（#3282）。
      const notExpired = this.#notExpired();
      const updated = await this.#db
        .update(attachments)
        .set(target)
        .where(
          and(
            inArray(attachments.id, queryable),
            isNull(attachments.conversationId),
            isNull(attachments.externalEventId),
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
        // 残りは、すでに同じ宛先へ結ばれている（冪等。新しくはない）か、別の宛先（conflicts）か、無い。
        // UPDATE は上でもう確定している。この SELECT が落ちたら、呼び手には `newlyBound` が届かないので、
        // この呼びで新しく結んだ分をここで戻してから元の例外を投げ直す（#3592。戻しも落ちたら stderr へ1行残す）。
        const others = await this.#db
          .select({
            id: attachments.id,
            conversationId: attachments.conversationId,
            externalEventId: attachments.externalEventId,
          })
          .from(attachments)
          .where(and(inArray(attachments.id, rest), notExpired))
          .catch(async (error: unknown) => {
            await this.unbind([...newlyBound], target).catch((rollbackError: unknown) => {
              process.stderr.write(
                `alteroidd: 添付の結び付けを戻せなかった（${'conversationId' in target ? '会話' : '外部イベント'}へ結んだ ${newlyBound.size} 件が残る）: ${reasonOf(rollbackError)}\n`,
              );
            });
            throw error;
          });
        for (const row of others) {
          const same =
            'conversationId' in target
              ? row.conversationId === target.conversationId && row.externalEventId === null
              : row.externalEventId === target.externalEventId && row.conversationId === null;
          (same ? bound : conflicts).add(row.id);
        }
      }
    }
    return {
      bound: ids.filter((id) => bound.has(id)),
      // 重ねて渡された同じ id は最初の1回だけ数える（memory・fs と同じ。bound・missing・conflicts は渡した数のまま）。
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
      .set('conversationId' in target ? { conversationId: null } : { externalEventId: null })
      .where(
        and(
          inArray(attachments.id, queryable),
          'conversationId' in target
            ? eq(attachments.conversationId, target.conversationId)
            : eq(attachments.externalEventId, target.externalEventId),
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
        or(
          lte(attachments.expiresAt, now),
          and(
            isNull(attachments.conversationId),
            isNull(attachments.externalEventId),
            lte(attachments.createdAt, unboundBefore),
          ),
        ),
      )
      .returning({ id: attachments.id });
    return removed.length;
  }
}
