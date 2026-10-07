import {
  AttachmentRejectedError,
  reasonOf,
  validateAttachmentBatch,
  type AttachmentBindResult,
  type AttachmentLimits,
  type AttachmentMeta,
  type AttachmentRef,
  type AttachmentStore,
} from '@alteroid/core';

export type AttachmentBatchFailure = {
  ok: false;
  status: 400 | 413;
  body: {
    error: string;
    code:
      | 'attachment_missing'
      | 'attachment_conflict'
      | 'attachment_forbidden'
      | AttachmentRejectedError['code'];
  };
};

export type AttachmentBatchResult = { ok: true; refs: AttachmentRef[] } | AttachmentBatchFailure;

export interface AttachmentBatchOptions {
  readonly store: Pick<AttachmentStore, 'getMeta'>;
  readonly limits: AttachmentLimits;
  readonly bind: (ids: readonly string[]) => Promise<AttachmentBindResult>;
  readonly unbind: (ids: readonly string[]) => Promise<unknown>;
  readonly isBoundElsewhere: (meta: AttachmentMeta) => boolean;
  readonly conflictMessage: string;
  readonly onlyUploadedBy?: string;
  // 宛先ごとに直列化する: 呼び A が新しく結んだ x を A が戻す前に呼び B が「結び済み」として通ると、A の戻しが B の通った発言の添付を外すため。
  readonly serializeKey: string;
}

const tails = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await result;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

export async function checkAndBindAttachments(
  attachmentIds: readonly string[] | undefined,
  options: AttachmentBatchOptions,
): Promise<AttachmentBatchResult> {
  if (attachmentIds === undefined || attachmentIds.length === 0) return { ok: true, refs: [] };
  return serialized(options.serializeKey, () => checkAndBind(attachmentIds, options));
}

async function checkAndBind(
  attachmentIds: readonly string[],
  options: AttachmentBatchOptions,
): Promise<AttachmentBatchResult> {
  const { store, limits } = options;
  const ids = [...new Set(attachmentIds)];
  const fail = (code: AttachmentBatchFailure['body']['code'], error: string) =>
    ({ ok: false, status: 400, body: { error, code } }) as const;
  const missingOf = (list: readonly string[]) =>
    fail('attachment_missing', `添付が見つからない（期限切れの可能性）: ${list.join(', ')}`);
  const conflictOf = (list: readonly string[]) =>
    fail('attachment_conflict', `${options.conflictMessage}: ${list.join(', ')}`);
  try {
    validateAttachmentBatch(
      ids.map(() => 0),
      limits,
    );
    const metas = await Promise.all(ids.map((id) => store.getMeta(id)));
    const missing = ids.filter((_, index) => metas[index] === undefined);
    if (missing.length > 0) return missingOf(missing);
    const found = metas.filter((meta) => meta !== undefined);
    validateAttachmentBatch(
      found.map((meta) => meta.size),
      limits,
    );
    if (options.onlyUploadedBy !== undefined) {
      const mine = options.onlyUploadedBy;
      const foreign = found.filter((meta) => meta.uploadedBy !== mine);
      if (foreign.length > 0) {
        return fail(
          'attachment_forbidden',
          `この連携の鍵が上げた添付だけを付けられる: ${foreign.map((m) => m.id).join(', ')}`,
        );
      }
    }
    const elsewhere = found.filter(options.isBoundElsewhere);
    if (elsewhere.length > 0) return conflictOf(elsewhere.map((m) => m.id));
    const bound = await options.bind(ids);
    if (bound.missing.length > 0 || bound.conflicts.length > 0) {
      // 戻すのは `bind` が「この呼びで新しく結んだ」と返した id だけ: すでに同じ宛先へ結んであった id まで戻すと、通った発言の添付が外れるため。
      if (bound.newlyBound.length > 0) await options.unbind(bound.newlyBound);
      if (bound.missing.length > 0) return missingOf(bound.missing);
      return conflictOf(bound.conflicts);
    }
    return {
      ok: true,
      refs: found.map((meta) => ({
        id: meta.id,
        name: meta.name,
        mediaType: meta.mediaType,
        size: meta.size,
        sha256: meta.sha256,
      })),
    };
  } catch (error) {
    if (error instanceof AttachmentRejectedError) {
      return {
        ok: false,
        status: error.code === 'too_many' ? 400 : 413,
        body: { error: reasonOf(error), code: error.code },
      };
    }
    throw error;
  }
}
