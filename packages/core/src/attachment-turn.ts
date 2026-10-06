import type { AgentInputImage } from './agent-session.js';
import { sniffAttachmentImageType, type AttachmentStore } from './attachment.js';
import { stripNul } from './nul-guard.js';
import type { AttachmentRef } from './schema.js';

/**
 * 添付の参照を、クローンのターンへ渡す形にする（Issue #3111 段1b）。**人間の発言に限らない汎用の関数**
 * （外部イベントなど、添付を運ぶ他の起点も同じ関数を通す。呼び出し側が起点ごとに通知行を本文のどこへ
 * 置くかだけを決める）。
 *
 * - **画像**（png / jpeg / webp / gif。中身の先頭で再確認する。宣言ではなく中身が決める）は
 *   base64 にして {@link AgentInputImage} へ。モデルへ渡る。
 * - **すべての添付**について通知行を1行ずつ作る（`[添付] id=… name=… type=… size=… sha256=…`）。
 *   画像以外の取り出し口は段2。いまはメタデータだけを渡す。
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

export async function resolveTurnAttachments(
  stores: { readonly attachments: AttachmentStore },
  refs: readonly AttachmentRef[],
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
      noticeLines.push(`[添付] ${described}`);
      continue;
    }
    images.push({
      mediaType: imageType,
      data: Buffer.from(found.bytes).toString('base64'),
      name: ref.name,
    });
    noticeLines.push(`[添付] ${described}（画像として渡した）`);
  }
  return { images, noticeLines };
}
