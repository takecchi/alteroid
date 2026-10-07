import { describe, expect, it } from 'vitest';

import { RESET_CONFIRM_GROUPS } from '@alteroid/core';

import { RESET_CONFIRM_GROUPS_FOR_TEST } from './routes/settings';

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
