import type { AppraisalValue } from '@alteroid/core';

/**
 * 評定3値（`good`/`bad`/`unclear`）の日本語ラベルの、`apps/web` 内の唯一の出所。
 *
 * **`@alteroid/core` の `APPRAISAL_LABELS`（`packages/core/src/schema.ts`）と
 * 字面を一致させること。** `apps/web` は `@alteroid/core` から実行時の値を
 * import できない決まり（`eslint.config.js` の `no-restricted-imports`）なので、
 * ここへ書き写す。**複製は書き写した瞬間から古くなりうる**——一致は
 * `appraisal-labels.test.ts`（テストファイルは例外で `@alteroid/core` を
 * import できる）が測る。
 *
 * issue #2164: 以前は `manager-detail.tsx` / `commitments.tsx` が
 * それぞれ同じ内容の switch 文を持ち、`appraisal-stats.tsx` だけが
 * 「良かった／悪かった」という別の字面を独自に持っていた（同じ3値が入口ごとに
 * 別の呼び名で出ていた）。ここへ集約し、3か所ともここを読む。
 *
 * 未知の値（`AppraisalValue` に無い値）への倒れ先は、呼び出し側の
 * 網羅性チェック（`assertAppraisalHandled` 等）に任せる——ここは値の集合を
 * 増減させない、字面だけの置き場である。
 */
export const APPRAISAL_LABELS: Record<AppraisalValue, string> = {
  good: 'うまくいった',
  bad: 'うまくいかなかった',
  unclear: '判定できない',
};
