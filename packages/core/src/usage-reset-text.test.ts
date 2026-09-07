import { describe, expect, it } from 'vitest';

import { parseNoticeResetAt } from './usage-reset-text.js';

/**
 * **#682**: `resetsAt` が届かなかった回の期限を、文言から読む。
 *
 * **ここが固定するのは3つである:**
 *
 * 1. **本番で観測された形が読めること**（下の逐語の fixture）
 * 2. **受けない形を受けないこと**（帯が無い / 日付が付いている / 桁が壊れている）
 * 3. **誤りが必ず「今日より短い」側にしか出ないこと**（窓の挟み）
 *
 * **窓の挟みが効いていることを測るのが、いちばん重要である** ——外れても
 * 「いまの振る舞い（設定の既定）に落ちるだけ」という主張の本体がそこに在る。
 */
describe('#682: 上限の文言からリセット時刻を読む', () => {
  /** 既定の冷却（5時間）。窓としてそのまま渡す。 */
  const FALLBACK = 5 * 60 * 60 * 1000;

  /**
   * **本番の実測そのまま**（2026-09-07、Railway。#682 の本文の逐語）。
   *
   * `10:10pm (Asia/Tokyo)` = `13:10Z` で、**同じ鍵に前の回で入っていた
   * `resetsAt`（`2026-09-07T13:10:00.000Z`）と一致していた。**
   */
  const OBSERVED = "You've hit your session limit · resets 10:10pm (Asia/Tokyo)";
  const OBSERVED_AT = Date.parse('2026-09-07T11:42:22.701Z');

  it('本番で観測された形を読む（分まで一致する）', () => {
    const parsed = parseNoticeResetAt(OBSERVED, { at: OBSERVED_AT, withinMs: FALLBACK });
    expect(parsed).toBe(Date.parse('2026-09-07T13:10:00.000Z'));
  });

  it('分が 0 の回は分が描かれない（`10pm` の形）', () => {
    // 測った `Au` が `minute: u === 0 ? void 0 : "2-digit"` を渡している。
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
    // `10:10pm (Asia/Tokyo)` は UTC の 13:10。基準が 14:00Z なら**翌日**である。
    const parsed = parseNoticeResetAt(OBSERVED, {
      at: Date.parse('2026-09-07T14:00:00.000Z'),
      // 窓を広げないと挟みで落ちる（下の「窓の外は使わない」がそれを測る）。
      withinMs: 30 * 60 * 60 * 1000,
    });
    expect(parsed).toBe(Date.parse('2026-09-08T13:10:00.000Z'));
  });

  describe('⚠️ 誤りは必ず「今日より短い」側にしか出ない（窓の挟み）', () => {
    it('窓の外は使わない（既定へ落ちる）', () => {
      // **これが「この経路のせいで長く寝る形は作れない」の本体である。**
      // 5時間の窓に対して、次の 10:10pm は 21時間28分先である。
      const parsed = parseNoticeResetAt(OBSERVED, {
        at: Date.parse('2026-09-07T15:42:22.701Z'),
        withinMs: FALLBACK,
      });
      expect(parsed).toBeUndefined();
    });

    it('日付が無いことから来る +24h の事故が、挟みだけで消える', () => {
      // 窓（5時間）＜ 24時間なので、「今日か明日か」を取り違えても必ず落ちる。
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
      // この repo の既存の歯に fixture が在る形である。
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
      // 測った `Au` は 24 時間より先を `Sep 8, 10:10pm (Asia/Tokyo)` と描く。
      // **受けなくてよい** —— どうせ窓の挟みで落ちる。
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
      // **この歯は「夏時間の切り替わりで外れた回を捨てる」機構そのものを測って
      // いる。** 突き合わせを外すと、外れた値が黙って通る。
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
      // **`undefined` でもこの歯は通る。** 米国の夏時間の切り替わり（この日の
      // 02:00 → 03:00）に当たる帯では「その時刻が存在しない」ことがありうるので、
      // **どちらでも嘘にならない形で測る** —— 測っているのは「返すなら描き直せる」
      // であって「必ず返る」ではない。
      expect(parsed === undefined || typeof parsed === 'number').toBe(true);
    });
  });
});
