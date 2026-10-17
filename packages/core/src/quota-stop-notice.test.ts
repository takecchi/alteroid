import { describe, expect, it } from 'vitest';

import { quotaMarkOf } from './quota-stop-notice.js';

// 2026-10-17T00:00:00Z（JST 9時）
const NOW = Date.parse('2026-10-17T00:00:00.000Z');

describe('quotaMarkOf: 週の上限（日付付きの resets）を読む（#5026）', () => {
  it('日付付きの文言から resetText と resetsAt が入る', () => {
    const mark = quotaMarkOf(
      { text: "You've hit your weekly limit · resets Oct 22, 4pm (Asia/Tokyo)" },
      NOW,
    );
    expect(mark.resetText).toBe('resets Oct 22, 4pm (Asia/Tokyo)');
    expect(mark.resetsAt).toBe(Date.parse('2026-10-22T07:00:00.000Z'));
  });

  it('8日を超える日付は resetsAt に入れない（言い回しは残る）', () => {
    const mark = quotaMarkOf(
      { text: "You've hit your weekly limit · resets Oct 30, 4pm (Asia/Tokyo)" },
      NOW,
    );
    expect(mark.resetText).toBe('resets Oct 30, 4pm (Asia/Tokyo)');
    expect(mark.resetsAt).toBeUndefined();
  });

  it('24時間以内の形は今までどおり読む', () => {
    const mark = quotaMarkOf(
      { text: "You've hit your session limit · resets 1:00pm (Asia/Tokyo)" },
      NOW,
    );
    expect(mark.resetText).toBe('resets 1:00pm (Asia/Tokyo)');
    expect(mark.resetsAt).toBe(Date.parse('2026-10-17T04:00:00.000Z'));
  });

  it('facts の resetsAt が在れば、文言より先にそれを使う', () => {
    const mark = quotaMarkOf(
      { text: "You've hit your weekly limit · resets Oct 22, 4pm (Asia/Tokyo)", resetsAt: 123 },
      NOW,
    );
    expect(mark.resetsAt).toBe(123);
  });
});
