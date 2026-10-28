import { z } from 'zod';

import type { DigestDeltaState } from './digest-session-delta.js';

// 「いまの全体」の説明文と固定文の控え（畳み）を、セッション id と一緒に預けて、resume で同じ id が戻ったときだけ読み戻すための形。
// 倒れ側は常に全文: 読めない・形が合わない・大きすぎるものは「無い」として扱う（`parseFoldState` は投げない）。

/** 預ける JSON の字数の上限。超えたら預けない（読み戻せないだけで、全文へ倒れる）。要約の節本文が控えの大半を占める。 */
export const FOLD_STATE_MAX_CHARS = 512_000;

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

const foldStateSchema = z.object({
  v: z.literal(1),
  /** この控えが指す会話。読み戻すのは、resume する id と一致したときだけ。 */
  sessionId: z.string().min(1),
  /** `#situationExplained` の中身（鍵 → 出した本文）。 */
  situation: z.array(z.tuple([z.string(), z.string()])),
  /** `#situationTurnsSinceFull`。20ターン周期を再起動で数え直さないため。 */
  turnsSinceFull: z.number().int().nonnegative(),
  digest: z.object({
    sections: z
      .object({ at: isoDate, sections: z.array(z.tuple([z.string(), z.string()])) })
      .nullable(),
    fixed: z.array(z.string()),
    requests: z.array(z.tuple([z.string(), z.object({ text: z.string(), at: isoDate })])),
    paragraphs: z.array(z.string()),
    reports: z.array(
      z.tuple([
        z.string(),
        z.object({ key: z.string(), chars: z.number().int().nonnegative(), at: isoDate }),
      ]),
    ),
  }),
  /** 預けた時点の文脈占有の観測。読み戻した最初のターンで「要約が走りうるか」を判定し直すため（無ければ全文へ倒れる）。 */
  usage: z
    .object({
      totalTokens: z.number().nonnegative().optional(),
      autoCompactThreshold: z.number().nonnegative().optional(),
      isAutoCompactEnabled: z.boolean().optional(),
      error: z.string().optional(),
    })
    .nullable(),
  growthTokens: z.number().nonnegative(),
});

export interface FoldState {
  v: 1;
  sessionId: string;
  situation: [string, string][];
  turnsSinceFull: number;
  digest: DigestDeltaState;
  usage: {
    totalTokens?: number;
    autoCompactThreshold?: number;
    isAutoCompactEnabled?: boolean;
    error?: string;
  } | null;
  growthTokens: number;
}

/** 大きすぎれば `null`（預けない）。 */
export function serializeFoldState(state: FoldState): string | null {
  const text = JSON.stringify(state);
  return text.length > FOLD_STATE_MAX_CHARS ? null : text;
}

/** 壊れている・形が合わない・NUL を含むものは `null`。投げない: 読み戻しの失敗でクローンの起動を止めないため。 */
export function parseFoldState(raw: string): FoldState | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = foldStateSchema.safeParse(json);
  if (!parsed.success) return null;
  const { usage, ...rest } = parsed.data;
  return {
    ...rest,
    usage:
      usage === null
        ? null
        : {
            ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
            ...(usage.autoCompactThreshold === undefined
              ? {}
              : { autoCompactThreshold: usage.autoCompactThreshold }),
            ...(usage.isAutoCompactEnabled === undefined
              ? {}
              : { isAutoCompactEnabled: usage.isAutoCompactEnabled }),
            ...(usage.error === undefined ? {} : { error: usage.error }),
          },
  } as FoldState;
}
