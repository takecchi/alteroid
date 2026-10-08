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
 * 添付の参照を、クローンのターンへ渡す形にする（Issue #3111 段1b）。**人間の発言に限らない汎用の関数**
 * （外部イベントなど、添付を運ぶ他の起点も同じ関数を通す。呼び出し側が起点ごとに通知行を本文のどこへ
 * 置くかだけを決める）。
 *
 * - **画像**（png / jpeg / webp / gif。中身の先頭で再確認する。宣言ではなく中身が決める）は
 *   base64 にして {@link AgentInputImage} へ。モデルへ渡る。
 *   **ただし中身が画像でも、大きさが `limits.maxImageBytes` を超えるなら画像としては渡さない**（#3325。
 *   宣言が画像以外なら「その他」の上限で保存できるので、モデル側の画像の上限でターンが落ちないように）。
 *   通知行で理由と `attachment_fetch` での開け方を言う。
 *   **経路が Bedrock / Vertex のときは、1枚の上限を base64 で 5 MB に収まる raw（3,750,000 バイト）と `maxImageBytes` の小さい方にする**（#3743）。
 *   経路は上げる時点では決まらない（どのターンで使われるかが未定）ので、ここ（ターンを組む時点）で、そのターンの環境から決める。
 *   **大きさと寸法の断りは、上げる時点（`validateAttachmentInput`）が本線で、ここは受け皿である**（#3697）。
 *   受け止めるのは、断る前に預かった旧データ・上限を後から下げたとき・宣言が画像以外のもの（中身は見ずに預かる）の3つ。
 *   ここを消さないこと: 上げる時点だけにすると、この3つがターンごと API に落とされる。
 * - **寸法**（幅・高さのどちらかが 8000px 超。中身のヘッダから読む）の画像も、画像としては渡さず通知行で言う（#3697）。
 *   外す理由の優先は 1枚の大きさ（#3325）→ 寸法 → ターンの予算（#3696）。寸法で外したものは予算を使わない。
 *   寸法が読めない（壊れた・切れたヘッダ）ときは断れる根拠が無いので、今までどおり画像として渡す。
 * - **ターンの画像には枚数と合計の予算がある**（#3696。`limits.maxTurnImages` / `maxTurnImageBytes`）。
 *   **新しい発言から数えて**枠に入る分だけを画像として渡し、同じ発言の中は後ろの画像から外す。
 *   外したものは画像としては渡さず、通知行で理由と開け方を言う（受け付けと保存は妨げない）。
 *   ターンをまたぐ積み上がりはここでは見ない。
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

const OPEN_HINT = 'attachment_fetch で取り出して Read で開ける';

/**
 * 発言ごとの添付をまとめて解く。`groups` は**古い順**（到着順）で、結果も同じ順・同じ長さ。
 * ターンの画像の予算は新しい（後ろの）グループから使う。グループの中は前から使う（外れるのは後ろ）。
 */
export async function resolveTurnAttachmentGroups(
  stores: { readonly attachments: AttachmentStore },
  groups: readonly (readonly AttachmentRef[])[],
  /** 既定は {@link readAttachmentLimits}（環境変数。`attachment_fetch` などと同じ流れ）。 */
  limits: TurnAttachmentLimits = readAttachmentLimits().limits,
  /** ターンを走らせる環境（経路の判定に読む。#3743）。 */
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

/** 1つの発言（または1つの束）の添付を解く。{@link resolveTurnAttachmentGroups} の1グループ版。 */
export async function resolveTurnAttachments(
  stores: { readonly attachments: AttachmentStore },
  refs: readonly AttachmentRef[],
  /** 既定は {@link readAttachmentLimits}（環境変数。`attachment_fetch` などと同じ流れ）。 */
  limits: TurnAttachmentLimits = readAttachmentLimits().limits,
  routeEnv: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTurnAttachments> {
  const [only] = await resolveTurnAttachmentGroups(stores, [refs], limits, routeEnv);
  return only ?? { images: [], noticeLines: [] };
}
