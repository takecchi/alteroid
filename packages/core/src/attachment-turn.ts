import type { AgentInputImage } from './agent-session.js';
import {
  formatImageLimit,
  readAttachmentLimits,
  sniffAttachmentImageType,
  type AttachmentLimits,
  type AttachmentStore,
} from './attachment.js';
import { stripNul } from './nul-guard.js';
import type { AttachmentRef } from './schema.js';

/**
 * 添付の参照を、クローンのターンへ渡す形にする（Issue #3111 段1b）。**人間の発言に限らない汎用の関数**
 * （外部イベントなど、添付を運ぶ他の起点も同じ関数を通す。呼び出し側が起点ごとに通知行を本文のどこへ
 * 置くかだけを決める）。
 *
 * - **画像**（png / jpeg / webp / gif。中身の先頭で再確認する。宣言ではなく中身が決める）は
 *   base64 にして {@link AgentInputImage} へ。モデルへ渡る。
 *   **ただし中身が画像でも、大きさが `limits.maxImageBytes` を超えるなら画像としては渡さない**（#3325。
 *   宣言が画像以外なら「その他」の上限で保存できるので、モデル側の画像の上限でターンが落ちないように）。
 *   通知行で理由と `attachment_fetch` での開け方を言う。
 * - **すべての添付**について通知行を1行ずつ作る（`[添付] id=… name=… type=… size=… sha256=…`）。
 *   画像以外は中身を渡さず、`attachment_fetch` で取り出して `Read` で開ける案内を付ける（段2）。
 * - **見つからない・読めない添付でもターンは続ける。** 通知行で「見つからない（期限切れの可能性）」と言う。
 *
 * 中身は**ここで読むだけ**で、受信箱・日誌・記憶には写さない。
 */
export interface ResolvedTurnAttachments {
  /** モデルへ渡す画像（添付の順）。 */
  readonly images: AgentInputImage[];
  /** 通知行（添付ごとに1行。`refs` と同じ順）。 */
  readonly noticeLines: string[];
}

/** 取り出しの案内（画像以外の通知行に付ける。画像も取り出せる）。 */
export const FETCH_HINT = ' （attachment_fetch で取り出して Read で開ける）';

export async function resolveTurnAttachments(
  stores: { readonly attachments: AttachmentStore },
  refs: readonly AttachmentRef[],
  /** 既定は {@link readAttachmentLimits}（環境変数。`attachment_fetch` などと同じ流れ）。 */
  limits: AttachmentLimits = readAttachmentLimits().limits,
): Promise<ResolvedTurnAttachments> {
  const images: AgentInputImage[] = [];
  const noticeLines: string[] = [];
  for (const ref of refs) {
    const described = `id=${ref.id} name=${stripNul(ref.name)} type=${ref.mediaType} size=${ref.size} sha256=${ref.sha256}`;
    let found: Awaited<ReturnType<AttachmentStore['get']>>;
    try {
      found = await stores.attachments.get(ref.id);
    } catch {
      noticeLines.push(
        `[添付] ${described} 中身を読めなかった（置き場の失敗。再送で直る場合がある）`,
      );
      continue;
    }
    if (found === undefined) {
      noticeLines.push(`[添付] ${described} 見つからない（期限切れの可能性）`);
      continue;
    }
    const imageType = sniffAttachmentImageType(found.bytes);
    if (imageType === undefined) {
      noticeLines.push(`[添付] ${described}${FETCH_HINT}`);
      continue;
    }
    if (found.bytes.length > limits.maxImageBytes) {
      noticeLines.push(
        `[添付] ${described}（画像の上限（${formatImageLimit(limits.maxImageBytes)}）を超えるので画像としては渡していない。attachment_fetch で取り出して Read で開ける）`,
      );
      continue;
    }
    images.push({
      mediaType: imageType,
      data: Buffer.from(found.bytes).toString('base64'),
      name: ref.name,
    });
    noticeLines.push(`[添付] ${described}（画像として渡した）${FETCH_HINT}`);
  }
  return { images, noticeLines };
}
