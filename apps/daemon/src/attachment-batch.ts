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

/**
 * **発言・外部イベントに添える添付の id を検査して結び付ける**（`POST /chat` #3111、`POST /events` #3113 段3）。
 *
 * 個数 → 存在 → 合計の上限 →（連携の鍵のときだけ）上げた主体 → 別の宛先に結び付き済みか → 結び付け →
 * `AttachmentRef` 化、の順。呼び手は `clone.post` の**前**に呼び、`ok: false` なら何も投函しない。
 *
 * 置き場所が core でなく daemon なのは、返すものが HTTP の形（状態コードと `{error, code}`）だからである。
 * core の `validateAttachmentBatch` / `AttachmentStore` は口を問わない部品で、ここはそれを HTTP の口2つで
 * 同じ順に束ねるだけ。
 */

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
  /** 結び付け先（`store.bind(ids, conversationId)` / `store.bindToExternalEvent(ids, eventId)`）。 */
  readonly bind: (ids: readonly string[]) => Promise<AttachmentBindResult>;
  /**
   * 結び付けを戻す（`store.unbind(ids, target)`）。`bind` が `missing` / `conflicts` を返して断るとき、**その呼びで
   * 新しく結んだ分だけ**を渡す（以前から同じ宛先に結んであった分は渡さない）。
   */
  readonly unbind: (ids: readonly string[]) => Promise<unknown>;
  /** すでに「別の」宛先に結び付いているか。会話は同じ会話への結び付きを許し、外部イベントはどの結び付きも許さない。 */
  readonly isBoundElsewhere: (meta: AttachmentMeta) => boolean;
  /** 結び付き済みで断るときの文言の頭（`: <id, ...>` が続く）。 */
  readonly conflictMessage: string;
  /** 連携の鍵のときだけ渡す（`uploaderOf(principal)`）。この主体が上げたものだけを通す。 */
  readonly onlyUploadedBy?: string;
  /**
   * **宛先ごとの直列化の鍵**（`conversation:<会話 id>` / `externalEvent:<イベント id>`。#3633）。同じ鍵の呼びは、
   * 「検査 → bind → 断る回の unbind」を1本ずつ順に通る。呼び A が新しく結んだ x を、A が戻す前に同じ宛先へ送る
   * 呼び B が「結び済み」として通ると、A の戻しが B の通った発言の添付を外すため。`bind` の中でストアが例外の回に
   * 行う戻し（#3592）も、この `bind` 呼びの内側なので同じ窓が閉じる。**プロセス内の鍵**であり、デーモンが1プロセス
   * である前提（`ManagerPool` などの像と同じ）。別の宛先の呼びは互いに待たない。
   */
  readonly serializeKey: string;
}

/** 鍵ごとの末尾の Promise。前の呼びが終わる（成功でも失敗でも）のを待ってから次を始める。空になった鍵は消す。 */
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
    // 個数だけを先に（存在しない id を引く前に、数で断る）。
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
      // 断る（発言・イベントは投函されない）ので、この呼びで結んだ分を戻す。`bind` は部分的に結ぶ設計なので、
      // 戻さないと結んだ分が他で使えなくなる（#3270）。戻すのは `bind` が「この呼びで新しく結んだ」と返した id だけ:
      // すでに同じ宛先へ結んであった id（前の発言や、同時に届いた別の呼びが先に結んだもの）まで戻すと、通った発言の
      // 添付が外れる。検査時点の `getMeta` では、検査から `bind` の間の変化を見分けられない（#3282）。
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
