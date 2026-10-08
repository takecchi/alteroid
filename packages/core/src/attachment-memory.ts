import {
  canBindAttachmentTo,
  isAttachmentBound,
  isAttachmentExpired,
  isBoundTo,
  isAttachmentPrunable,
  prepareAttachment,
  readAttachmentLimits,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from './attachment.js';
import { assertNoNul, hasNul } from './nul-guard.js';

/** インメモリの添付置き場（テストと `createMemoryStores()` 用。契約は `attachment-contract.ts`）。 */
export class MemoryAttachmentStore implements AttachmentStore {
  readonly #rows = new Map<string, { meta: AttachmentMeta; bytes: Uint8Array }>();
  readonly #options: AttachmentStoreOptions;

  constructor(options: AttachmentStoreOptions = {}) {
    this.#options = options;
  }

  async put(input: AttachmentPutInput): Promise<AttachmentMeta> {
    const limits = this.#options.limits ?? readAttachmentLimits().limits;
    const meta = prepareAttachment(input, limits, this.#options.now?.() ?? new Date());
    this.#rows.set(meta.id, { meta, bytes: Uint8Array.from(input.bytes) });
    return meta;
  }

  async get(id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | undefined> {
    if (hasNul(id)) return undefined;
    const row = this.#readableRow(id);
    return row === undefined ? undefined : { meta: row.meta, bytes: Uint8Array.from(row.bytes) };
  }

  async getMeta(id: string): Promise<AttachmentMeta | undefined> {
    if (hasNul(id)) return undefined;
    return this.#readableRow(id)?.meta;
  }

  /** 期限を過ぎたものは、prune が走る前でも「無い」（#3522）。 */
  #readableRow(id: string): { meta: AttachmentMeta; bytes: Uint8Array } | undefined {
    const row = this.#rows.get(id);
    return row === undefined || isAttachmentExpired(row.meta, this.#now()) ? undefined : row;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
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

  /** 結び付け先は会話・外部イベント・マネージャーの報告のどれか1つ。同じ宛先なら冪等、別の宛先なら conflict。 */
  #bindTo(ids: readonly string[], target: AttachmentBindTarget): AttachmentBindResult {
    const bound: string[] = [];
    const newlyBound: string[] = [];
    const missing: string[] = [];
    const conflicts: string[] = [];
    for (const id of ids) {
      const row = hasNul(id) ? undefined : this.#readableRow(id);
      if (row === undefined) {
        missing.push(id);
      } else if (!canBindAttachmentTo(row.meta, target)) {
        conflicts.push(id);
      } else {
        if (!isAttachmentBound(row.meta)) newlyBound.push(id);
        row.meta = { ...row.meta, ...target };
        bound.push(id);
      }
    }
    return { bound, newlyBound, missing, conflicts };
  }

  async unbind(ids: readonly string[], target: AttachmentBindTarget): Promise<string[]> {
    const unbound: string[] = [];
    for (const id of new Set(ids)) {
      const row = hasNul(id) ? undefined : this.#rows.get(id);
      if (row !== undefined && isBoundTo(row.meta, target)) {
        const rest: { -readonly [K in keyof AttachmentMeta]: AttachmentMeta[K] } = { ...row.meta };
        delete rest.conversationId;
        delete rest.externalEventId;
        delete rest.managerReportId;
        row.meta = rest;
        unbound.push(id);
      }
    }
    return unbound;
  }

  async remove(ids: readonly string[]): Promise<string[]> {
    const removed: string[] = [];
    for (const id of new Set(ids)) {
      if (!hasNul(id) && this.#rows.delete(id)) removed.push(id);
    }
    return removed;
  }

  async prune(now: Date): Promise<number> {
    let count = 0;
    for (const [id, row] of [...this.#rows]) {
      if (isAttachmentPrunable(row.meta, now)) {
        this.#rows.delete(id);
        count += 1;
      }
    }
    return count;
  }
}
