import { describe, expect, it } from 'vitest';

import { parseNoticeResetAt } from './usage-reset-text.js';

describe('#682: 上限の文言からリセット時刻を読む', () => {
  const FALLBACK = 5 * 60 * 60 * 1000;

  const OBSERVED = "You've hit your session limit · resets 10:10pm (Asia/Tokyo)";
  const OBSERVED_AT = Date.parse('2026-09-07T11:42:22.701Z');

  it('本番で観測された形を読む（分まで一致する）', () => {
    const parsed = parseNoticeResetAt(OBSERVED, { at: OBSERVED_AT, withinMs: FALLBACK });
    expect(parsed).toBe(Date.parse('2026-09-07T13:10:00.000Z'));
  });

  it('分が 0 の回は分が描かれない（`10pm` の形）', () => {
    const parsed = parseNoticeResetAt('resets 10pm (Asia/Tokyo)', {
      at: Date.parse('2026-09-07T11:42:22.701Z'),
      withinMs: FALLBACK,
    });
    expect(parsed).toBe(Date.parse('2026-09-07T13:00:00.000Z'));
  });

  it('帯が UTC でも読む（帯を当てに行かず、書いてある帯で解釈する）', () => {
    const parsed = parseNoticeResetAt('resets 1:30pm (UTC)', {
      at: Date.parse('2026-09-07T11:42:22.701Z'),
      withinMs: FALLBACK,
    });
    expect(parsed).toBe(Date.parse('2026-09-07T13:30:00.000Z'));
  });

  it('午前 / 正午 / 深夜の境界を取り違えない（12am は 0 時、12pm は 12 時）', () => {
    expect(
      parseNoticeResetAt('resets 12am (UTC)', {
        at: Date.parse('2026-09-07T21:00:00.000Z'),
        withinMs: FALLBACK,
      }),
    ).toBe(Date.parse('2026-09-08T00:00:00.000Z'));
    expect(
      parseNoticeResetAt('resets 12pm (UTC)', {
        at: Date.parse('2026-09-07T09:00:00.000Z'),
        withinMs: FALLBACK,
      }),
    ).toBe(Date.parse('2026-09-07T12:00:00.000Z'));
  });

  it('日付を跨ぐ回も、次に来るその時刻を採る', () => {
    const parsed = parseNoticeResetAt(OBSERVED, {
      at: Date.parse('2026-09-07T14:00:00.000Z'),
      withinMs: 30 * 60 * 60 * 1000,
    });
    expect(parsed).toBe(Date.parse('2026-09-08T13:10:00.000Z'));
  });

  describe('⚠️ 誤りは必ず「今日より短い」側にしか出ない（窓の挟み）', () => {
    it('窓の外は使わない（既定へ落ちる）', () => {
      const parsed = parseNoticeResetAt(OBSERVED, {
        at: Date.parse('2026-09-07T15:42:22.701Z'),
        withinMs: FALLBACK,
      });
      expect(parsed).toBeUndefined();
    });

    it('日付が無いことから来る +24h の事故が、挟みだけで消える', () => {
      const parsed = parseNoticeResetAt('resets 11:42pm (UTC)', {
        at: Date.parse('2026-09-07T23:43:00.000Z'),
        withinMs: FALLBACK,
      });
      expect(parsed).toBeUndefined();
    });

    it('基準時刻と同じ分は使わない（`at` より後でなければ期限にならない）', () => {
      const parsed = parseNoticeResetAt('resets 11:42pm (UTC)', {
        at: Date.parse('2026-09-07T23:42:10.000Z'),
        withinMs: FALLBACK,
      });
      expect(parsed).toBeUndefined();
    });
  });

  describe('受けない形', () => {
    it('帯が書かれていない形は受けない（どの帯なのか決められない）', () => {
      for (const text of [
        'weekly limit resets 5pm',
        'resets at 5pm',
        "You've hit your session limit · resets 10:10pm",
      ]) {
        expect(
          parseNoticeResetAt(text, { at: OBSERVED_AT, withinMs: FALLBACK }),
          text,
        ).toBeUndefined();
      }
    });

    it('1日以上先の形（日付が付く）は受けない', () => {
      expect(
        parseNoticeResetAt('resets Sep 8, 10:10pm (Asia/Tokyo)', {
          at: OBSERVED_AT,
          withinMs: 40 * 60 * 60 * 1000,
        }),
      ).toBeUndefined();
    });

    it('時計として在りえない桁は捨てる', () => {
      for (const text of ['resets 13:10pm (UTC)', 'resets 0:10am (UTC)', 'resets 10:70pm (UTC)']) {
        expect(
          parseNoticeResetAt(text, { at: OBSERVED_AT, withinMs: FALLBACK }),
          text,
        ).toBeUndefined();
      }
    });

    it('実在しない帯の名前では投げずに諦める', () => {
      expect(
        parseNoticeResetAt('resets 10:10pm (Mars/Olympus)', {
          at: OBSERVED_AT,
          withinMs: FALLBACK,
        }),
      ).toBeUndefined();
    });

    it('文言そのものが無関係でも投げない', () => {
      for (const text of ['', 'resets', 'no time here', "You've hit your usage limit"]) {
        expect(
          parseNoticeResetAt(text, { at: OBSERVED_AT, withinMs: FALLBACK }),
          text,
        ).toBeUndefined();
      }
    });
  });

  describe('描き直して突き合わせる', () => {
    it('返す値は、その帯で読んだ時刻をそのまま描き直せる', () => {
      const at = Date.parse('2026-03-08T09:00:00.000Z');
      const parsed = parseNoticeResetAt('resets 4:30am (America/New_York)', {
        at,
        withinMs: 6 * 60 * 60 * 1000,
      });
      if (parsed !== undefined) {
        const rendered = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(parsed));
        expect(rendered).toBe('04:30');
      }
      expect(parsed === undefined || typeof parsed === 'number').toBe(true);
    });
  });
});
