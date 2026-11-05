import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';

// 畳みの控えを持たない DigestSessionDelta（`ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT` が無効の既定の形）。
// 預けた控えの字面（`exportState`）と、全文へ戻す口（`reset` / `forgetFixed`）・読み戻しの口（`importState`）だけが残っている。

describe('DigestSessionDelta: 畳みの控えを持たない形', () => {
  it('⭐ reset は捨てる記録が無いので偽を返す', () => {
    expect(new DigestSessionDelta().reset()).toBe(false);
  });

  it('⭐ exportState は空の控えを返す（預け先に書かれる字面）', () => {
    expect(new DigestSessionDelta().exportState()).toEqual({
      sections: null,
      fixed: [],
      requests: [],
      paragraphs: [],
      reports: [],
    });
  });

  it('⭐ importState は何も取り込まない: 有効だった頃の控えを読み戻しても、書き出しは空のまま', () => {
    const delta = new DigestSessionDelta();
    delta.importState({
      sections: { at: '2026-01-01T00:00:00.000Z', sections: [['## 状況', '- a']] },
      fixed: ['a'],
      requests: [['timer', { text: 'x', at: '2026-01-01T00:00:00.000Z' }]],
      paragraphs: ['p'],
      reports: [['m1', { key: 'k', chars: 2000, at: '2026-01-01T00:00:00.000Z' }]],
    });
    expect(delta.exportState()).toEqual({
      sections: null,
      fixed: [],
      requests: [],
      paragraphs: [],
      reports: [],
    });
    expect(delta.reset()).toBe(false);
  });

  it('forgetFixed は何も起こさない', () => {
    const delta = new DigestSessionDelta();
    delta.forgetFixed();
    expect(delta.reset()).toBe(false);
  });
});
