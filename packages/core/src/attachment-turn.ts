import type { AgentInputImage } from './agent-session.js';
import {
  formatImageLimit,
  imageRouteOverNotice,
  readAttachmentLimits,
  routeImageCapBytes,
  sniffAttachmentImageType,
  TurnImageBudget,
  turnImageOverNotice,
  type AttachmentStore,
  type TurnAttachmentLimits,
} from './attachment.js';
import { imageDimensionOverNotice, isImageOverDimension } from './attachment-image-size.js';
import { stripNul } from './nul-guard.js';
import type { AttachmentRef } from './schema.js';

/**
 * 添付の参照を、クローンのターンへ渡す形にする。人間の発言に限らない汎用の関数で、外部イベントなど
 * 他の起点も同じ関数を通す。
 *
 * - 画像かどうかは宣言ではなく中身の先頭が決める。
 * - 中身が画像でも `limits.maxImageBytes` を超えるなら画像としては渡さない: 宣言が画像以外なら「その他」の
 *   上限で保存できるので、モデル側の画像の上限でターンが落ちないようにする。
 * - 経路ごとの1枚の上限は、上げる時点では決まらない（どのターンで使われるかが未定）ので、ここでそのターンの環境から決める。
 * - 大きさと寸法の断りは、上げる時点（`validateAttachmentInput`）が本線で、ここは受け皿である。旧データ・上限を
 *   後から下げたとき・宣言が画像以外のもの（中身は見ずに預かる）はここへ来る。ここを消すと、それらがターンごと API に落とされる。
 * - 寸法が読めない（壊れた・切れたヘッダ）ときは断れる根拠が無いので、画像として渡す。
 * - 外す理由の優先は 1枚の大きさ → 寸法 → ターンの予算。寸法で外したものは予算を使わない。
 * - ターンの画像の予算は新しい発言から数え、同じ発言の中は後ろの画像から外す。ターンをまたぐ積み上がりはここでは見ない。
 * - 見つからない・読めない添付でもターンは続ける。
 *
 * 中身はここで読むだけで、受信箱・日誌・記憶には写さない。
 */
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
  routeEnv: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTurnAttachments[]> {
  const budget = new TurnImageBudget(limits);
  const routeCap = routeImageCapBytes(limits, routeEnv);
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
      if (routeCap !== undefined && found.bytes.length > routeCap) {
        out.noticeLines.push(`[添付] ${described}${imageRouteOverNotice(OPEN_HINT)}`);
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
  routeEnv: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTurnAttachments> {
  const [only] = await resolveTurnAttachmentGroups(stores, [refs], limits, routeEnv);
  return only ?? { images: [], noticeLines: [] };
}
