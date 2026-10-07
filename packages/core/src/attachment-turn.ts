import type { AgentInputImage } from './agent-session.js';
import {
  formatImageLimit,
  readAttachmentLimits,
  sniffAttachmentImageType,
  TurnImageBudget,
  turnImageOverNotice,
  type AttachmentStore,
  type TurnAttachmentLimits,
} from './attachment.js';
import { imageDimensionOverNotice, isImageOverDimension } from './attachment-image-size.js';
import { stripNul } from './nul-guard.js';
import type { AttachmentRef } from './schema.js';

export interface ResolvedTurnAttachments {
  readonly images: AgentInputImage[];
  readonly noticeLines: string[];
}

export const FETCH_HINT = ' （attachment_fetch で取り出して Read で開ける）';

const OPEN_HINT = 'attachment_fetch で取り出して Read で開ける';

/** `groups` は古い順。ターンの画像の予算は新しい（後ろの）グループから使う。 */
export async function resolveTurnAttachmentGroups(
  stores: { readonly attachments: AttachmentStore },
  groups: readonly (readonly AttachmentRef[])[],
  limits: TurnAttachmentLimits = readAttachmentLimits().limits,
): Promise<ResolvedTurnAttachments[]> {
  const budget = new TurnImageBudget(limits);
  const results: ResolvedTurnAttachments[] = groups.map(() => ({ images: [], noticeLines: [] }));
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const out = results[index];
    if (out === undefined) continue;
    for (const ref of groups[index] ?? []) {
      const described = `id=${ref.id} name=${stripNul(ref.name)} type=${ref.mediaType} size=${ref.size} sha256=${ref.sha256}`;
      let found: Awaited<ReturnType<AttachmentStore['get']>>;
      try {
        found = await stores.attachments.get(ref.id);
      } catch {
        out.noticeLines.push(
          `[添付] ${described} 中身を読めなかった（置き場の失敗。再送で直る場合がある）`,
        );
        continue;
      }
      if (found === undefined) {
        out.noticeLines.push(`[添付] ${described} 見つからない（期限切れの可能性）`);
        continue;
      }
      const imageType = sniffAttachmentImageType(found.bytes);
      if (imageType === undefined) {
        out.noticeLines.push(`[添付] ${described}${FETCH_HINT}`);
        continue;
      }
      if (found.bytes.length > limits.maxImageBytes) {
        out.noticeLines.push(
          `[添付] ${described}（画像の上限（${formatImageLimit(limits.maxImageBytes)}）を超えるので画像としては渡していない。${OPEN_HINT}）`,
        );
        continue;
      }
      if (isImageOverDimension(found.bytes, imageType)) {
        out.noticeLines.push(`[添付] ${described}${imageDimensionOverNotice(OPEN_HINT)}`);
        continue;
      }
      const over = budget.take(found.bytes.length);
      if (over !== undefined) {
        out.noticeLines.push(`[添付] ${described}${turnImageOverNotice(over, limits, OPEN_HINT)}`);
        continue;
      }
      out.images.push({
        mediaType: imageType,
        data: Buffer.from(found.bytes).toString('base64'),
        name: ref.name,
      });
      out.noticeLines.push(`[添付] ${described}（画像として渡した）${FETCH_HINT}`);
    }
  }
  return results;
}

export async function resolveTurnAttachments(
  stores: { readonly attachments: AttachmentStore },
  refs: readonly AttachmentRef[],
  limits: TurnAttachmentLimits = readAttachmentLimits().limits,
): Promise<ResolvedTurnAttachments> {
  const [only] = await resolveTurnAttachmentGroups(stores, [refs], limits);
  return only ?? { images: [], noticeLines: [] };
}
