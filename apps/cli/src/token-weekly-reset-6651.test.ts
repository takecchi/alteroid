import { describe, expect, it } from 'vitest';

import { describeWeeklyReset } from './token.js';

const WEEKLY = {
  // JST 11/11（水）22:00
  at: Date.parse('2026-11-11T13:00:00.000Z'),
  zone: 'Asia/Tokyo',
  observedAt: '2026-11-09T12:00:00.000Z',
};

describe('alteroid token list の週の枠のリセット（#6651）', () => {
  it('毎週の曜日と時刻を、観測した時間帯で言い、推測だと断る', () => {
    const line = describeWeeklyReset(WEEKLY, Date.parse('2026-11-10T00:00:00.000Z'));
    expect(line).toContain('毎週 水曜 22:00（Asia/Tokyo）');
    expect(line).toContain('次は 2026-11-11T13:00:00.000Z');
    expect(line).toContain('上限の文言から読んだ推測');
  });

  it('観測した回を過ぎたら、次の週の同じ時刻を言う', () => {
    const line = describeWeeklyReset(WEEKLY, Date.parse('2026-11-12T00:00:00.000Z'));
    expect(line).toContain('次は 2026-11-18T13:00:00.000Z');
  });

  it('時間帯が読めなければ、曜日を作らずそう言う', () => {
    const line = describeWeeklyReset({ ...WEEKLY, zone: 'Not/AZone' }, Date.now());
    expect(line).toContain('時間帯 Not/AZone を読めない');
  });
});
