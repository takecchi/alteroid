import { describe, expect, it } from 'vitest';

import { RESET_CONFIRM_GROUPS } from '@alteroid/core';

import { RESET_CONFIRM_GROUPS_FOR_TEST } from './routes/settings';

/**
 * **Web の設定画面のリセットの確認の文が、core の `RESET_CONFIRM_GROUPS` と一致することを測る歯**（issue #2261）。
 *
 * core の `RESET_CONFIRM_GROUPS`（`packages/core/src/workspace-reset.ts`）が、確認の文の並びの
 * 唯一の出所である。CLI（`apps/cli/src/reset.ts`）はそれを import し、`POST /reset` の OpenAPI
 * description は `describeResetTargets()` で組み立てる。Web（`apps/web/app/routes/settings.tsx`）
 * だけは、実行時のコードが core をルートから取り込まないので、手で書き写して持っている。
 *
 * この歯が無かった間に、写しは既に1ラベルずれていた（Web は「引き受けたまま終わっていない仕事」、
 * core・CLI・OpenAPI は「引き受けた仕事」）。`settings.test.tsx` の既存の歯が測るのは「Web の写しが
 * `WorkspaceResetSummary` の全キーを覆うこと」だけで、core と同じ語・同じ並びかは見ていなかった。
 *
 * **並び・ラベル・キーの全部を測る。** 並びは確認の文の語順そのものであり、ラベルは人間が読む語であり、
 * キーは「その語が何を消すと言っているか」である。どれがずれても、同じリセットについて Web と CLI が
 * 違うことを言う。
 */
describe('RESET_CONFIRM_GROUPS（Web の写し）と core の一致（issue #2261）', () => {
  it('並び・ラベル・キーまで core の RESET_CONFIRM_GROUPS と同じ', () => {
    expect(
      RESET_CONFIRM_GROUPS_FOR_TEST,
      '【赤の意味】Web の設定画面（apps/web/app/routes/settings.tsx）の RESET_CONFIRM_GROUPS が、' +
        'core（packages/core/src/workspace-reset.ts）の RESET_CONFIRM_GROUPS とずれた。' +
        'core が出所なので、Web の写しを core に合わせること（core を変えるなら、CLI の確認の文と ' +
        'POST /reset の OpenAPI の説明も変わる）。',
    ).toEqual(RESET_CONFIRM_GROUPS);
  });
});
