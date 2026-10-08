import {
  AttachmentRejectedError,
  validateAttachmentBatch,
  type AttachmentLimits,
  type AttachmentMeta,
  type AttachmentStore,
} from './attachment.js';
import { reasonOf } from './dropped-record.js';
import type { AttachmentRef } from './schema.js';

/**
 * クローンが人間へ返す発言（`reply_attach` / `conversation_post`）に添付を添える段取り（Issue #4126）。
 *
 * 人間・連携の鍵の経路（`apps/daemon/src/attachment-batch.ts`）と同じ「存在 → 上限 → 結び付け」の順で、
 * 1つでも落ちたら何も添えない。**違うのは「別の宛先」の扱いだけ**: クローンは全部読める主体なので、
 * すでに別の会話・外部イベントへ結ばれている添付は結び直さず、そのまま控えで指す（宛先の検査を掛けない）。
 */

export type OutboundAttachmentResult =
  | {
      readonly ok: true;
      /** この呼び出しで新しく添える控え（すでにこのターンで添えた分は含まない）。 */
      readonly refs: AttachmentRef[];
      /** この呼び出しで新しく会話へ結んだ id。あとで失敗したときに戻してよいのはこれだけ。 */
      readonly newlyBound: string[];
    }
  | { readonly ok: false; readonly message: string };

export interface OutboundAttachmentOptions {
  readonly conversationId: string;
  readonly limits: AttachmentLimits;
  /** このターンの返信にすでに添えた控え。個数・合計は新しい分と合わせて数える。 */
  readonly alreadyAttached?: readonly AttachmentRef[];
}

const tails = new Map<string, Promise<unknown>>();

// 宛先ごとに直列化する: 呼び A が新しく結んだ x を A が戻す前に呼び B が「結び済み」として通ると、A の戻しが B の添付を外すため
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

function refOf(meta: AttachmentMeta): AttachmentRef {
  return {
    id: meta.id,
    name: meta.name,
    mediaType: meta.mediaType,
    size: meta.size,
    sha256: meta.sha256,
  };
}

function isUnbound(meta: AttachmentMeta): boolean {
  return meta.conversationId === undefined && meta.externalEventId === undefined;
}

export async function checkAndBindOutboundAttachments(
  stores: { readonly attachments: AttachmentStore },
  ids: readonly string[],
  options: OutboundAttachmentOptions,
): Promise<OutboundAttachmentResult> {
  return serialized(options.conversationId, () => checkAndBind(stores, ids, options));
}

async function checkAndBind(
  stores: { readonly attachments: AttachmentStore },
  ids: readonly string[],
  options: OutboundAttachmentOptions,
): Promise<OutboundAttachmentResult> {
  const already = options.alreadyAttached ?? [];
  const alreadyIds = new Set(already.map((ref) => ref.id));
  const fresh = [...new Set(ids)].filter((id) => !alreadyIds.has(id));
  const refuse = (message: string): OutboundAttachmentResult => ({
    ok: false,
    message: `${message}。何も添えていない。`,
  });
  if (fresh.length === 0) return { ok: true, refs: [], newlyBound: [] };

  const metas: AttachmentMeta[] = [];
  const missing: string[] = [];
  for (const id of fresh) {
    let meta;
    try {
      meta = await stores.attachments.getMeta(id);
    } catch (error) {
      return refuse(`添付 ${id} の控えを読めなかった: ${reasonOf(error)}`);
    }
    if (meta === undefined) missing.push(id);
    else metas.push(meta);
  }
  if (missing.length > 0) {
    return refuse(
      `添付が見つからない（保持期限が過ぎて消えた、または id の誤り。file_put の応答の id を確かめる）: ${missing.join(', ')}`,
    );
  }

  try {
    validateAttachmentBatch(
      [...already.map((ref) => ref.size), ...metas.map((meta) => meta.size)],
      options.limits,
    );
  } catch (error) {
    if (error instanceof AttachmentRejectedError) {
      const detail = metas.map((meta) => `${meta.id}（${meta.name}, ${meta.size} バイト）`);
      const earlier =
        already.length === 0
          ? ''
          : `このターンですでに添えた ${already.length} 個と合わせて数える。`;
      return refuse(`${reasonOf(error)}。${earlier}今回の対象: ${detail.join(', ')}`);
    }
    throw error;
  }

  const unbound = metas.filter(isUnbound).map((meta) => meta.id);
  let newlyBound: string[] = [];
  if (unbound.length > 0) {
    let bound;
    try {
      bound = await stores.attachments.bind(unbound, options.conversationId);
    } catch (error) {
      return refuse(`添付を会話へ結べなかった: ${reasonOf(error)}`);
    }
    if (bound.missing.length > 0 || bound.conflicts.length > 0) {
      // 戻すのは `bind` が「この呼びで新しく結んだ」と返した id だけ: すでに同じ宛先へ結んであった id まで戻すと、通った発言の添付が外れるため
      if (bound.newlyBound.length > 0) {
        await stores.attachments.unbind(bound.newlyBound, {
          conversationId: options.conversationId,
        });
      }
      return refuse(
        bound.missing.length > 0
          ? `添付が結ぶ間に見つからなくなった（保持期限）: ${bound.missing.join(', ')}`
          : `添付が結ぶ間に別の宛先へ結ばれた: ${bound.conflicts.join(', ')}`,
      );
    }
    newlyBound = bound.newlyBound;
  }
  return { ok: true, refs: metas.map(refOf), newlyBound };
}

/** 添えたあとの段（日誌への書き込みなど）が失敗したとき、この呼び出しで新しく結んだぶんだけを未結び付けへ戻す。 */
export async function releaseOutboundAttachments(
  stores: { readonly attachments: AttachmentStore },
  newlyBound: readonly string[],
  conversationId: string,
): Promise<void> {
  if (newlyBound.length === 0) return;
  await stores.attachments.unbind(newlyBound, { conversationId });
}
