import {
  isAttachmentPrunable,
  prepareAttachment,
  readAttachmentLimits,
  type AttachmentBindResult,
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
    const row = this.#rows.get(id);
    return row === undefined ? undefined : { meta: row.meta, bytes: Uint8Array.from(row.bytes) };
  }

  async getMeta(id: string): Promise<AttachmentMeta | undefined> {
    if (hasNul(id)) return undefined;
    return this.#rows.get(id)?.meta;
  }

  async bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult> {
    assertNoNul('conversationId', conversationId);
    const bound: string[] = [];
    const missing: string[] = [];
    const conflicts: string[] = [];
    for (const id of ids) {
      const row = hasNul(id) ? undefined : this.#rows.get(id);
      if (row === undefined) {
        missing.push(id);
      } else if (
        row.meta.conversationId !== undefined &&
        row.meta.conversationId !== conversationId
      ) {
        conflicts.push(id);
      } else {
        row.meta = { ...row.meta, conversationId };
        bound.push(id);
      }
    }
    return { bound, missing, conflicts };
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
