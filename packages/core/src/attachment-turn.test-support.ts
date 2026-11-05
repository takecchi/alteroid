import {
  readAttachmentLimits,
  type AttachmentStore,
  type TurnAttachmentLimits,
} from './attachment.js';
import { resolveTurnAttachmentGroups } from './attachment-turn.js';
import type { AttachmentRef } from './schema.js';

type ResolvedTurnAttachments = Awaited<ReturnType<typeof resolveTurnAttachmentGroups>>[number];

// 試験の補助: 1つの発言ぶんの添付だけを解く。本番はクローンが `resolveTurnAttachmentGroups` を直に呼び、
// 発言の束をまとめて解く（ターンの画像の予算を束全体で数えるため）。1件の束として呼べば同じ結果になる。
export async function resolveTurnAttachments(
  stores: { readonly attachments: AttachmentStore },
  refs: readonly AttachmentRef[],
  limits: TurnAttachmentLimits = readAttachmentLimits().limits,
  routeEnv: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTurnAttachments> {
  const [only] = await resolveTurnAttachmentGroups(stores, [refs], limits, routeEnv);
  return only ?? { images: [], noticeLines: [] };
}
