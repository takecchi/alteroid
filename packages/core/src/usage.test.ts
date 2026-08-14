import { describe, expect, it } from 'vitest';

import {
  foldUsageSnapshot,
  sumUsageRows,
  type UsageBaseline,
  usageDate,
  type UsageRow,
  type UsageTotals,
  ZERO_USAGE,
} from './usage.js';

const AT = '2026-08-14T10:00:00.000Z';
const LATER = '2026-08-14T11:00:00.000Z';

function totals(over: Partial<UsageTotals>): UsageTotals {
  return { ...ZERO_USAGE, ...over };
}

function baseline(models: Record<string, UsageTotals>, over: Partial<UsageBaseline> = {}) {
  return {
    managerId: 'm1',
    models,
    updatedAt: AT,
    resets: 0,
    ...over,
  } satisfies UsageBaseline;
}

describe('累積スナップショットを増分へ畳む', () => {
  it('基準が無ければ全量が増分になる', () => {
    const fold = foldUsageSnapshot(null, { models: { opus: totals({ costUsd: 1.5 }) } }, AT);
    expect(fold.delta).toEqual({ opus: totals({ costUsd: 1.5 }) });
    expect(fold.reset).toBeUndefined();
  });

  it('累積を足さずに差分だけ入れる（同じ累積が2回来ても二重計上しない）', () => {
    // SDK の型コメント: 「each result carries the running total so far, so read the
    // latest result rather than summing across results」。ここを足すとターン数だけ
    // 費用が膨らむ。
    const first = foldUsageSnapshot(
      null,
      { models: { opus: totals({ outputTokens: 100, costUsd: 1 }) } },
      AT,
    );
    const second = foldUsageSnapshot(
      { ...first.baseline, managerId: 'm1' },
      { models: { opus: totals({ outputTokens: 250, costUsd: 3 }) } },
      LATER,
    );
    expect(second.delta).toEqual({ opus: totals({ outputTokens: 150, costUsd: 2 }) });

    // 同じものが再送されても増分は無い（イベント再送に耐える）。
    const again = foldUsageSnapshot(
      { ...second.baseline, managerId: 'm1' },
      { models: { opus: totals({ outputTokens: 250, costUsd: 3 }) } },
      LATER,
    );
    expect(again.delta).toEqual({});
    expect(again.reset).toBeUndefined();
  });

  it('動いていないモデルの行は作らない', () => {
    const fold = foldUsageSnapshot(
      baseline({ opus: totals({ costUsd: 1 }), sonnet: totals({ costUsd: 2 }) }),
      { models: { opus: totals({ costUsd: 1 }), sonnet: totals({ costUsd: 2.5 }) } },
      LATER,
    );
    expect(Object.keys(fold.delta)).toEqual(['sonnet']);
  });

  describe('数え直し（resume / mid-session の /clear）', () => {
    it('減ったら数え直しとして扱い、記録済みの分は保持したまま新しい累積を全量足す', () => {
      // 累積 $5 まで記録済み → resume で 0 から始まり、次に読めた累積が $3。
      // 実際に使った額は $8 なので、$3 を足すのが正しい。0 にすると resume 後の
      // 1ターンぶんが黙って消える。
      const fold = foldUsageSnapshot(
        baseline({ opus: totals({ outputTokens: 500, costUsd: 5 }) }),
        { models: { opus: totals({ outputTokens: 300, costUsd: 3 }) } },
        LATER,
      );
      expect(fold.delta).toEqual({ opus: totals({ outputTokens: 300, costUsd: 3 }) });
      expect(fold.reset).toEqual({
        at: LATER,
        fromCostUsd: 5,
        toCostUsd: 3,
        fromSessionId: undefined,
        toSessionId: undefined,
      });
    });

    it('基準にあったモデルが消えたことも数え直しである', () => {
      const fold = foldUsageSnapshot(
        baseline({ opus: totals({ costUsd: 5 }) }),
        { models: { sonnet: totals({ costUsd: 1 }) } },
        LATER,
      );
      expect(fold.reset).toBeDefined();
      expect(fold.delta).toEqual({ sonnet: totals({ costUsd: 1 }) });
    });

    it('数え直しを数えて時刻を残す（黙って数え直さない）', () => {
      const fold = foldUsageSnapshot(
        baseline({ opus: totals({ costUsd: 5 }) }, { resets: 2, lastResetAt: AT }),
        { models: { opus: totals({ costUsd: 1 }) } },
        LATER,
      );
      expect(fold.baseline.resets).toBe(3);
      expect(fold.baseline.lastResetAt).toBe(LATER);
    });

    it('数え直しが無ければ回数も時刻も動かさない', () => {
      const fold = foldUsageSnapshot(
        baseline({ opus: totals({ costUsd: 1 }) }, { resets: 1, lastResetAt: AT }),
        { models: { opus: totals({ costUsd: 2 }) } },
        LATER,
      );
      expect(fold.baseline.resets).toBe(1);
      expect(fold.baseline.lastResetAt).toBe(AT);
    });

    it('session id が変わったことも記録に添える（ただし判定には使わない）', () => {
      // resume は同じ session id のまま累積を 0 に戻すので、session id の一致を
      // 「数え直していない」の根拠にしてはいけない。
      const same = foldUsageSnapshot(
        baseline({ opus: totals({ costUsd: 5 }) }, { sessionId: 's1' }),
        { sessionId: 's1', models: { opus: totals({ costUsd: 1 }) } },
        LATER,
      );
      expect(same.reset?.fromSessionId).toBe('s1');
      expect(same.reset?.toSessionId).toBe('s1');
    });

    it('増分は負にならない（一部のフィールドだけ減っても台帳を汚さない）', () => {
      const fold = foldUsageSnapshot(
        baseline({ opus: totals({ inputTokens: 10, outputTokens: 100, costUsd: 1 }) }),
        { models: { opus: totals({ inputTokens: 10, outputTokens: 90, costUsd: 1 }) } },
        LATER,
      );
      // 減少があるので数え直し扱い。全量が増分になり、どのフィールドも 0 以上。
      const opus = fold.delta.opus;
      expect(opus).toBeDefined();
      for (const value of Object.values(opus ?? {})) expect(value).toBeGreaterThanOrEqual(0);
    });
  });

  it('全部ゼロのスナップショットで基準を汚さない（増分も出ない）', () => {
    const fold = foldUsageSnapshot(null, { models: { opus: { ...ZERO_USAGE } } }, AT);
    expect(fold.delta).toEqual({});
    expect(fold.reset).toBeUndefined();
  });

  describe('クラッシュのゼロ値', () => {
    it('全部ゼロは「情報なし」として捨て、基準を下げない', () => {
      // SDK: crash/startup-error results may carry zeroed values。ゼロを数え直しと
      // して採用すると基準が 0 まで下がり、次に届いた本物の累積が丸ごと増分になる
      // ＝記録済みの分がもう一度積まれる。
      const before = baseline({ opus: totals({ outputTokens: 500, costUsd: 5 }) });
      const fold = foldUsageSnapshot(before, { models: { opus: { ...ZERO_USAGE } } }, LATER);
      expect(fold.delta).toEqual({});
      expect(fold.reset).toBeUndefined();
      expect(fold.baseline).toBe(before);
    });

    it('ゼロを捨てても、その後に届いた同じ累積で二重計上しない', () => {
      const before = baseline({ opus: totals({ costUsd: 5 }) });
      const dropped = foldUsageSnapshot(before, { models: { opus: { ...ZERO_USAGE } } }, LATER);
      const next = foldUsageSnapshot(
        dropped.baseline,
        { models: { opus: totals({ costUsd: 5 }) } },
        LATER,
      );
      expect(next.delta).toEqual({});
    });

    it('ゼロを捨てても、本物の数え直しは次の非ゼロで拾える', () => {
      // resume で 0 に戻り、ゼロの result が1回挟まっても、次の $3 を取り落とさない。
      const before = baseline({ opus: totals({ costUsd: 5 }) });
      const dropped = foldUsageSnapshot(before, { models: { opus: { ...ZERO_USAGE } } }, LATER);
      const next = foldUsageSnapshot(
        dropped.baseline,
        { models: { opus: totals({ costUsd: 3 }) } },
        LATER,
      );
      expect(next.reset).toBeDefined();
      expect(next.delta).toEqual({ opus: totals({ costUsd: 3 }) });
    });

    it('まだ何も記録していなければ、ゼロは普通に通す（基準を作る）', () => {
      const fold = foldUsageSnapshot(null, { models: {} }, AT);
      expect(fold.delta).toEqual({});
      expect(fold.baseline.models).toEqual({});
    });
  });
});

describe('行の合計', () => {
  it('モデルと日をまたいで足す', () => {
    const rows: UsageRow[] = [
      {
        date: '2026-08-13',
        managerId: 'm1',
        model: 'opus',
        totals: totals({ outputTokens: 10, costUsd: 1 }),
        updatedAt: AT,
      },
      {
        date: '2026-08-14',
        managerId: 'm2',
        model: 'sonnet',
        totals: totals({ outputTokens: 5, costUsd: 0.25 }),
        updatedAt: AT,
      },
    ];
    expect(sumUsageRows(rows)).toEqual(totals({ outputTokens: 15, costUsd: 1.25 }));
  });

  it('空なら全部ゼロ', () => {
    expect(sumUsageRows([])).toEqual(ZERO_USAGE);
  });
});

describe('日付の切り方', () => {
  it('ローカル時刻で切る（日報の「今日」と揃える）', () => {
    // UTC で切ると、日報がローカル時刻で動いているのと食い違う。
    const at = new Date(2026, 7, 14, 1, 30);
    expect(usageDate(at)).toBe('2026-08-14');
  });

  it('月日は 0 埋めする', () => {
    expect(usageDate(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });
});
