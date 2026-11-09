import { describe, expect, it } from 'vitest';

import {
  markTokenUnusable,
  markTokenUsable,
  normalizeTokenPool,
  type AgentToken,
} from './token-pool.js';
import { parseNoticeWeeklyReset } from './usage-reset-text.js';

// 2026-11-09T12:00Z（JST 11/9 月曜 21:00）に、週の枠の文言を受けた
const AT_ISO = '2026-11-09T12:00:00.000Z';
const AT = Date.parse(AT_ISO);
const WEEKLY = "You've hit your weekly limit · resets Nov 11, 10pm (Asia/Tokyo)";
// JST 11/11 22:00 = 2026-11-11T13:00Z
const RESET_AT = Date.parse('2026-11-11T13:00:00.000Z');

const TOKEN: AgentToken = { id: 'tok-a', label: 'a', value: 'fake-value-a', order: 0 };

describe('週の枠のリセットを文言から読む（#6651）', () => {
  it('週の枠の文言なら、リセットの瞬間と時間帯を返す', () => {
    expect(parseNoticeWeeklyReset(WEEKLY, AT)).toEqual({ at: RESET_AT, zone: 'Asia/Tokyo' });
  });

  it('週の枠でない文言（5時間の枠）は控えない', () => {
    expect(
      parseNoticeWeeklyReset("You've hit your limit · resets Nov 11, 10pm (Asia/Tokyo)", AT),
    ).toBeUndefined();
    expect(
      parseNoticeWeeklyReset("You've hit your session limit · resets 5pm (Asia/Tokyo)", AT),
    ).toBeUndefined();
  });

  it('週の枠でも、日付付きの時刻が無ければ控えない（曜日が決められない）', () => {
    expect(
      parseNoticeWeeklyReset("You've hit your weekly limit · resets 10pm (Asia/Tokyo)", AT),
    ).toBeUndefined();
  });
});

describe('鍵の行に、毎週のリセットとして控える（#6651）', () => {
  it('週の枠に当たったら、冷却と一緒に weeklyReset を書く', () => {
    const next = markTokenUnusable(TOKEN, { at: AT_ISO, message: WEEKLY, fallbackCooldownMs: 1 });
    expect(next.weeklyReset).toEqual({ at: RESET_AT, zone: 'Asia/Tokyo', observedAt: AT_ISO });
  });

  it('週以外の上限に当たっても、前に控えた予定は消さない', () => {
    const recorded = markTokenUnusable(TOKEN, {
      at: AT_ISO,
      message: WEEKLY,
      fallbackCooldownMs: 1,
    });
    const later = markTokenUnusable(recorded, {
      at: '2026-11-12T00:00:00.000Z',
      message: "You've hit your session limit · resets 5pm (Asia/Tokyo)",
      fallbackCooldownMs: 1,
    });
    expect(later.weeklyReset).toEqual(recorded.weeklyReset);
  });

  it('通ったこと（markTokenUsable）では消さない: 毎週の予定であって、いま止まっていることではない', () => {
    const recorded = markTokenUnusable(TOKEN, {
      at: AT_ISO,
      message: WEEKLY,
      fallbackCooldownMs: 1,
    });
    const usable = markTokenUsable(recorded, '2026-11-12T00:00:00.000Z');
    expect(usable.weeklyReset).toEqual(recorded.weeklyReset);
    expect(usable).not.toHaveProperty('cooldownUntil');
  });
});

describe('人が置き直したとき（PUT /tokens の全置換）の持ち越し（#6651）', () => {
  const recorded: AgentToken = {
    ...TOKEN,
    weeklyReset: { at: RESET_AT, zone: 'Asia/Tokyo', observedAt: AT_ISO },
  };
  const options = { now: () => new Date('2026-11-12T00:00:00.000Z'), newId: () => 'tok-new' };

  it('値が同じ行は、週の予定を持ち越す（並べ替え・改名で消えない）', () => {
    const [next] = normalizeTokenPool(
      [{ id: 'tok-a', label: 'renamed', order: 0 }],
      [recorded],
      options,
    );
    expect(next?.weeklyReset).toEqual(recorded.weeklyReset);
  });

  it('値が変わった行は持ち越さない（別のアカウントかもしれない）', () => {
    const [next] = normalizeTokenPool(
      [{ id: 'tok-a', label: 'a', value: 'fake-value-other', order: 0 }],
      [recorded],
      options,
    );
    expect(next).not.toHaveProperty('weeklyReset');
  });
});
