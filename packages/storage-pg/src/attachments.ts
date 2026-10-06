import {
  ATTACHMENT_UNBOUND_TTL_MS,
  assertNoNul,
  hasNul,
  prepareAttachment,
  readAttachmentLimits,
  type AttachmentBindResult,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from '@alteroid/core';
import { and, inArray, isNull, lte, or, eq } from 'drizzle-orm';

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
      .where(eq(attachments.id, id));
    const row = rows[0];
    if (row === undefined) return undefined;
    return { meta: toMeta(row), bytes: new Uint8Array(row.bytes) };
  }

  async getMeta(id: string): Promise<AttachmentMeta | undefined> {
    if (hasNul(id)) return undefined;
    const rows = await this.#db
      .select(META_COLUMNS)
      .from(attachments)
      .where(eq(attachments.id, id));
    return rows[0] === undefined ? undefined : toMeta(rows[0]);
  }

  async bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult> {
    assertNoNul('conversationId', conversationId);
    const queryable = [...new Set(ids.filter((id) => !hasNul(id)))];
    const bound = new Set<string>();
    const conflicts = new Set<string>();
    if (queryable.length > 0) {
      const updated = await this.#db
        .update(attachments)
        .set({ conversationId })
        .where(
          and(
            inArray(attachments.id, queryable),
            or(isNull(attachments.conversationId), eq(attachments.conversationId, conversationId)),
          ),
        )
        .returning({ id: attachments.id });
      for (const row of updated) bound.add(row.id);
      const rest = queryable.filter((id) => !bound.has(id));
      if (rest.length > 0) {
        const others = await this.#db
          .select({ id: attachments.id })
          .from(attachments)
          .where(inArray(attachments.id, rest));
        for (const row of others) conflicts.add(row.id);
      }
    }
    return {
      bound: ids.filter((id) => bound.has(id)),
      missing: ids.filter((id) => !bound.has(id) && !conflicts.has(id)),
      conflicts: ids.filter((id) => conflicts.has(id)),
    };
  }

  async prune(now: Date): Promise<number> {
    const unboundBefore = new Date(now.getTime() - ATTACHMENT_UNBOUND_TTL_MS);
    const removed = await this.#db
      .delete(attachments)
      .where(
        or(
          lte(attachments.expiresAt, now),
          and(isNull(attachments.conversationId), lte(attachments.createdAt, unboundBefore)),
        ),
      )
      .returning({ id: attachments.id });
    return removed.length;
  }
}
