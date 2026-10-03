import { describe, expect, it } from 'vitest';

import {
  CLONE_ACTOR_ID,
  CLONE_DISTILL_ACTOR_ID,
  CLONE_SUB_ACTOR_PREFIX,
  describeUnreadableUsage,
  describeUnreadableUsageRows,
  isCloneActor,
  foldOneshotUsage,
  foldUsageSnapshot,
  isSuccessResult,
  modelUsageOf,
  sessionModelUsageOf,
  formatUsd,
  summarizeUsage,
  sumUsageRows,
  type UsageBaseline,
  usageDate,
  type UsageFold,
  type UsageRow,
  usageSiteSchema,
  type UsageTotals,
  type UsageTurnRow,
  ZERO_USAGE,
} from './usage.js';

const AT = '2026-08-14T10:00:00.000Z';
const LATER = '2026-08-14T11:00:00.000Z';

function totals(over: Partial<UsageTotals>): UsageTotals {
  return { ...ZERO_USAGE, ...over };
}

function baseline(models: Record<string, UsageTotals>, over: Partial<UsageBaseline> = {}) {
  return {
    layer: 'manager',
    managerId: 'm1',
    models,
    updatedAt: AT,
    resets: 0,
    ...over,
  } satisfies UsageBaseline;
}

/**
 * 畳んだ結果を次の基準として使う。
 *
 * `foldUsageSnapshot` は基準が無いとき `layer` / `managerId` を空で返す契約なので、
 * 呼び出し側が知っている値をここで入れる（ドライバの `record` と同じ形）。
 *
 * **null なら握り潰さずに落とす。** 基準を返さない畳み込みは `oneshot` だけであり、
 * それを `cumulative` の続きに使うのは「1回で閉じる呼び出しに基準を持たせる」誤りに
 * あたる。ここで `?? undefined` などに倒すと、その誤りがテストの中で静かに通る。
 */
function nextBaseline(fold: UsageFold, over: Partial<UsageBaseline> = {}): UsageBaseline {
  if (fold.baseline === null) {
    throw new Error('基準を持たない畳み込み（oneshot）を cumulative の基準に使おうとした');
  }
  return { ...fold.baseline, layer: 'manager', managerId: 'm1', ...over };
}

describe('累積スナップショットを増分へ畳む', () => {
  it('基準が無ければ全量が増分になる', () => {
    const fold = foldUsageSnapshot(null, { models: { opus: totals({ costUsd: 1.5 }) } }, AT);
    expect(fold.delta).toEqual({ opus: totals({ costUsd: 1.5 }) });
    expect(fold.reset).toBeUndefined();
  });

  it('累積を足さずに差分だけ入れる（同じ累積が2回来ても二重計上しない）', () => {
    // SDK の型コメント: 「each result carries the running total so far, so read the latest result rather than summing across results」 [sdk-verbatim SDKResultSuccess.modelUsage]。ここを足すとターン数だけ
    // 費用が膨らむ。
    const first = foldUsageSnapshot(
      null,
      { models: { opus: totals({ outputTokens: 100, costUsd: 1 }) } },
      AT,
    );
    const second = foldUsageSnapshot(
      nextBaseline(first),
      { models: { opus: totals({ outputTokens: 250, costUsd: 3 }) } },
      LATER,
    );
    expect(second.delta).toEqual({ opus: totals({ outputTokens: 150, costUsd: 2 }) });

    // 同じものが再送されても増分は無い（イベント再送に耐える）。
    const again = foldUsageSnapshot(
      nextBaseline(second),
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
      expect(nextBaseline(fold).resets).toBe(3);
      expect(nextBaseline(fold).lastResetAt).toBe(LATER);
    });

    it('数え直しが無ければ回数も時刻も動かさない', () => {
      const fold = foldUsageSnapshot(
        baseline({ opus: totals({ costUsd: 1 }) }, { resets: 1, lastResetAt: AT }),
        { models: { opus: totals({ costUsd: 2 }) } },
        LATER,
      );
      expect(nextBaseline(fold).resets).toBe(1);
      expect(nextBaseline(fold).lastResetAt).toBe(AT);
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
      expect(nextBaseline(fold).models).toEqual({});
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
        layer: 'manager',
        site: 'session',
        totals: totals({ outputTokens: 10, costUsd: 1 }),
        updatedAt: AT,
      },
      {
        date: '2026-08-14',
        managerId: 'm2',
        model: 'sonnet',
        layer: 'manager',
        site: 'session',
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

describe('3軸の内訳', () => {
  const rows: UsageRow[] = [
    {
      date: '2026-08-13',
      managerId: 'm1',
      model: 'opus',
      layer: 'manager',
      site: 'session',
      totals: totals({ costUsd: 1 }),
      updatedAt: AT,
    },
    {
      date: '2026-08-14',
      managerId: 'm1',
      model: 'sonnet',
      layer: 'manager',
      site: 'session',
      totals: totals({ costUsd: 0.25 }),
      updatedAt: AT,
    },
    {
      date: '2026-08-14',
      managerId: 'm2',
      model: 'opus',
      layer: 'manager',
      site: 'session',
      totals: totals({ costUsd: 2 }),
      updatedAt: AT,
    },
  ];

  it('日・マネージャー・モデルの3軸すべてで引ける', () => {
    const summary = summarizeUsage(rows, []);
    expect(summary.total.costUsd).toBe(3.25);
    expect(summary.byDate).toEqual([
      { date: '2026-08-13', totals: totals({ costUsd: 1 }) },
      { date: '2026-08-14', totals: totals({ costUsd: 2.25 }) },
    ]);
    expect(summary.byManager.map((m) => m.managerId)).toEqual(['m1', 'm2']);
    expect(summary.byModel).toEqual([
      { model: 'opus', totals: totals({ costUsd: 3 }) },
      { model: 'sonnet', totals: totals({ costUsd: 0.25 }) },
    ]);
  });

  it('どの軸で足しても合計は同じ（口ごとに食い違わない）', () => {
    const summary = summarizeUsage(rows, []);
    // **6軸すべてを通す。** ここは3軸しか見ていなかった — 軸を足すたびに
    // 「その軸だけ合計に足し合わない」形が入りうるのに、それを止める歯が
    // 足した軸には無かった。**トークンの軸はとくに落ちやすい**（帰属の無い
    // 要素を落とすと、落とした分だけ静かに足りなくなる）。
    for (const axis of [
      summary.byDate,
      summary.byManager,
      summary.byModel,
      summary.byLayer,
      summary.bySite,
      summary.byToken,
    ]) {
      const sum = axis.reduce((acc, entry) => acc + entry.totals.costUsd, 0);
      expect(sum).toBeCloseTo(summary.total.costUsd, 10);
    }
  });

  it('トークンの軸は、帰属の無い分を null の要素として残す（落として合計から欠かせない）', () => {
    const summary = summarizeUsage(
      [
        { ...rows[0]!, tokenId: 'tok-a' },
        // 2件目は帰属が無い（プールを使っていない期間の行）。
        rows[1]!,
        { ...rows[2]!, tokenId: 'tok-a' },
      ],
      [],
    );

    // **`null` が消えていない。** 消えると byToken の合計だけが 0.25 少なくなり、
    // しかも他の軸は「出てこない値を 0 で補わない」約束なので、読み手には
    // 足りないことに気づく手がかりが無い。
    expect(summary.byToken).toEqual([
      { tokenId: 'tok-a', totals: totals({ costUsd: 3 }) },
      { tokenId: null, totals: totals({ costUsd: 0.25 }) },
    ]);
  });

  it('トークンの軸は id の昇順で、帰属の無い分が最後に来る', () => {
    const summary = summarizeUsage(
      [rows[0]!, { ...rows[1]!, tokenId: 'tok-b' }, { ...rows[2]!, tokenId: 'tok-a' }],
      [],
    );

    expect(summary.byToken.map((entry) => entry.tokenId)).toEqual(['tok-a', 'tok-b', null]);
  });

  it('プールを使っていない構成では、トークンの軸は null の1件だけになる', () => {
    // **これを「1本のトークンで全部使った」と読ませないための形である。**
    // 要素が1つしか無いことは、`tokensSince` が null であることと合わせて
    // 初めて「取れていない」と読める（口の側がその2つを並べて出す）。
    const summary = summarizeUsage(rows, []);
    expect(summary.byToken).toEqual([{ tokenId: null, totals: summary.total }]);
  });

  it('空なら全部空', () => {
    const summary = summarizeUsage([], []);
    expect(summary.total).toEqual(ZERO_USAGE);
    expect(summary.byDate).toEqual([]);
  });
});

describe('層と場所の内訳', () => {
  const rows: UsageRow[] = [
    // 同じ日・同じ actor・同じモデルでも、層と場所が違えば別の行である。
    // （`usageRowSchema` の「層と場所を鍵から外さないこと」）
    {
      date: '2026-08-14',
      managerId: 'clone',
      model: 'opus',
      layer: 'clone',
      site: 'session',
      totals: totals({ costUsd: 1.5 }),
      updatedAt: AT,
    },
    {
      date: '2026-08-14',
      managerId: 'clone',
      model: 'opus',
      layer: 'clone',
      site: 'distill',
      totals: totals({ costUsd: 0.5 }),
      updatedAt: AT,
    },
    {
      date: '2026-08-14',
      managerId: 'm1',
      model: 'opus',
      layer: 'manager',
      site: 'session',
      totals: totals({ costUsd: 2 }),
      updatedAt: AT,
    },
  ];

  it('誰が（層）と どこで（場所）の2軸で引ける', () => {
    const summary = summarizeUsage(rows, []);
    expect(summary.byLayer).toEqual([
      { layer: 'clone', totals: totals({ costUsd: 2 }) },
      { layer: 'manager', totals: totals({ costUsd: 2 }) },
    ]);
    expect(summary.bySite).toEqual([
      { site: 'distill', totals: totals({ costUsd: 0.5 }) },
      { site: 'session', totals: totals({ costUsd: 3.5 }) },
    ]);
  });

  it('モデル名では層を見分けられない（だから層の軸が要る）', () => {
    // 3行とも `opus` である。`ALTEROID_CLONE_MODEL` を置けばクローンとマネージャーは
    // 同じモデル帯に並ぶので、モデル軸だけでは「誰が使ったか」に答えられない。
    const summary = summarizeUsage(rows, []);
    expect(summary.byModel).toEqual([{ model: 'opus', totals: totals({ costUsd: 4 }) }]);
    expect(summary.byLayer.map((entry) => entry.layer)).toEqual(['clone', 'manager']);
  });

  it('記録の無い層・場所を 0 で補わない', () => {
    // 「使っていない」と「記録が無い」は別である。行に現れなかった値は一覧に出ない。
    const summary = summarizeUsage(
      rows.filter((row) => row.layer === 'clone'),
      [],
    );
    expect(summary.byLayer).toEqual([{ layer: 'clone', totals: totals({ costUsd: 2 }) }]);
    expect(summary.bySite.map((entry) => entry.site)).toEqual(['distill', 'session']);

    const onlySession = summarizeUsage(
      rows.filter((row) => row.site === 'session'),
      [],
    );
    expect(onlySession.bySite).toEqual([{ site: 'session', totals: totals({ costUsd: 3.5 }) }]);
  });

  it('層でも場所でも、足し上げれば合計に一致する（口ごとに食い違わない）', () => {
    const summary = summarizeUsage(rows, []);
    for (const axis of [summary.byLayer, summary.bySite]) {
      const sum = axis.reduce((acc, entry) => acc + entry.totals.costUsd, 0);
      expect(sum).toBeCloseTo(summary.total.costUsd, 10);
    }
  });
});

describe('回数の内訳（turnRows。model を鍵に持たない別会計）', () => {
  const rows: UsageRow[] = [
    {
      date: '2026-08-14',
      managerId: 'clone',
      model: 'opus',
      layer: 'clone',
      site: 'session',
      totals: totals({ costUsd: 1.5 }),
      updatedAt: AT,
    },
    // このモデル行には対応する turnRow を持たせない（distill 側）——
    // 該当の無い要素が `0` ではなく欄そのものを持たないことを確かめるため。
    {
      date: '2026-08-14',
      managerId: 'clone',
      model: 'opus',
      layer: 'clone',
      site: 'distill',
      totals: totals({ costUsd: 0.5 }),
      updatedAt: AT,
    },
    {
      date: '2026-08-14',
      managerId: 'm1',
      model: 'opus',
      layer: 'manager',
      site: 'session',
      totals: totals({ costUsd: 2 }),
      updatedAt: AT,
    },
  ];
  const turnRows: UsageTurnRow[] = [
    {
      date: '2026-08-14',
      managerId: 'clone',
      layer: 'clone',
      site: 'session',
      turns: 3,
      updatedAt: AT,
    },
    {
      date: '2026-08-14',
      managerId: 'm1',
      layer: 'manager',
      site: 'session',
      turns: 2,
      updatedAt: AT,
    },
  ];

  it('5軸（日・actor・層・場所・トークン）に turns が付く', () => {
    const summary = summarizeUsage(rows, turnRows);
    expect(summary.byDate).toEqual([
      { date: '2026-08-14', totals: totals({ costUsd: 4 }), turns: 5 },
    ]);
    expect(summary.byManager).toEqual([
      { managerId: 'clone', totals: totals({ costUsd: 2 }), turns: 3 },
      { managerId: 'm1', totals: totals({ costUsd: 2 }), turns: 2 },
    ]);
    expect(summary.byLayer).toEqual([
      { layer: 'clone', totals: totals({ costUsd: 2 }), turns: 3 },
      { layer: 'manager', totals: totals({ costUsd: 2 }), turns: 2 },
    ]);
    // トークンの帰属を1つも持たないので、byToken は null の1件に畳まれる
    // ——回数もそこへ付く（`groupByToken` と同じ向き）。
    expect(summary.byToken).toEqual([{ tokenId: null, totals: totals({ costUsd: 4 }), turns: 5 }]);
  });

  it('byModel の要素には turns の欄が無い（0 ではなく、欄そのものが無い）', () => {
    const summary = summarizeUsage(rows, turnRows);
    expect(summary.byModel).toEqual([{ model: 'opus', totals: totals({ costUsd: 4 }) }]);
    for (const entry of summary.byModel) {
      expect(entry).not.toHaveProperty('turns');
    }
  });

  it('該当する turnRow が無い要素は turns を持たない（0 ではなく欄が無い）', () => {
    const summary = summarizeUsage(rows, turnRows);
    // `site: 'distill'` に対応する turnRow は無い。
    const distill = summary.bySite.find((entry) => entry.site === 'distill');
    expect(distill).toBeDefined();
    expect(distill).not.toHaveProperty('turns');
    // 対して `session` には turnRow がある。
    const session = summary.bySite.find((entry) => entry.site === 'session');
    expect(session?.turns).toBe(5);
  });

  it('ルートの turns は turnRows の総和', () => {
    expect(summarizeUsage(rows, turnRows).turns).toBe(5);
  });

  it('turnRows が空ならルートの turns は欄そのものを持たない（0 ではない）', () => {
    const summary = summarizeUsage(rows, []);
    expect(summary).not.toHaveProperty('turns');
    for (const entry of summary.byDate) {
      expect(entry).not.toHaveProperty('turns');
    }
  });
});

describe('1回で閉じる query() の畳み込み（oneshot）', () => {
  it('基準を持たない（比べる相手がそもそも無い）', () => {
    const fold = foldOneshotUsage({ models: { opus: totals({ costUsd: 0.05 }) } });
    expect(fold.baseline).toBeNull();
    expect(fold.reset).toBeUndefined();
  });

  it('スナップショットの全量がそのまま増分になる', () => {
    const fold = foldOneshotUsage({
      models: { opus: totals({ outputTokens: 120, costUsd: 0.05 }) },
    });
    expect(fold.delta).toEqual({ opus: totals({ outputTokens: 120, costUsd: 0.05 }) });
  });

  it('高くついた回が黙って縮まない（基準との差にしない）', () => {
    // ここに基準を持たせると壊れ方が片側だけになる — 前回 $0.05 で今回 $0.08 の回は
    // 差の $0.03 しか積まれず（目減り）、前回 $0.05 で今回 $0.02 の回は減少なので
    // 数え直しとして全量が積まれる。**高くついた回だけが黙って縮む。**
    const cheap = foldOneshotUsage({ models: { opus: totals({ costUsd: 0.05 }) } });
    const expensive = foldOneshotUsage({ models: { opus: totals({ costUsd: 0.08 }) } });
    expect(cheap.delta).toEqual({ opus: totals({ costUsd: 0.05 }) });
    expect(expensive.delta).toEqual({ opus: totals({ costUsd: 0.08 }) });
  });

  it('全部ゼロのモデルは行を作らない（クラッシュのゼロ値）', () => {
    const fold = foldOneshotUsage({
      models: { opus: { ...ZERO_USAGE }, sonnet: totals({ costUsd: 0.01 }) },
    });
    expect(Object.keys(fold.delta)).toEqual(['sonnet']);
  });
});

describe('SDK の result から消費を読む', () => {
  it('成功した result だけを通す', () => {
    // SDK: crash/startup-error results may carry zeroed values。ゼロを通すと基準が
    // 下がり、次に届いた本物の累積が丸ごと増分になる。
    expect(isSuccessResult({ subtype: 'success' })).toBe(true);
    expect(isSuccessResult({ subtype: 'error_during_execution' })).toBe(false);
    expect(isSuccessResult({})).toBe(false);
  });

  it('modelUsage を読む（result.usage は読まない）', () => {
    // `usage` は MAIN AGENT LOOP ONLY。これを採ると作業者の消費が丸ごと落ちる。
    const models = modelUsageOf({
      usage: { inputTokens: 999, outputTokens: 999 },
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
          webSearchRequests: 1,
          costUSD: 0.5,
        },
      },
    });
    expect(models).toEqual({
      'claude-opus-5': {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
        webSearchRequests: 1,
        costUsd: 0.5,
      },
    });
  });

  it('金額の綴りは costUSD（大文字）である', () => {
    // ここを取り違えると費用だけが 0 で積まれ、その層が「安い」と読める。
    const wrong = modelUsageOf({ modelUsage: { opus: { costUsd: 0.5 } } });
    expect(wrong?.opus?.costUsd).toBe(0);
    const right = modelUsageOf({ modelUsage: { opus: { costUSD: 0.5 } } });
    expect(right?.opus?.costUsd).toBe(0.5);
  });

  it('モデルの仕様（contextWindow / maxOutputTokens）は写さない', () => {
    // 消費量ではないので、台帳に入れると集計で足されうる。
    const models = modelUsageOf({
      modelUsage: { opus: { contextWindow: 200000, maxOutputTokens: 64000, costUSD: 0.1 } },
    });
    // **Issue #2086 で期待値を変えた。** この素材はトークン5欄を1つも持たない
    // ——直す前はそれを「0トークン」として記録し、「本当に0だった」と見分けが
    // 付かなかった（地雷表「取れない軸に0の行を作る」）。直した後は、読めな
    // かった欄を `unreadable` に1として数える。この一致はテストの本題（仕様の
    // 2欄を写さないこと）とは無関係な副作用だが、`toEqual` が全欄を見るので
    // ここにも表れる。
    expect(models?.opus).toEqual({
      ...ZERO_USAGE,
      costUsd: 0.1,
      unreadable: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 1,
        webSearchRequests: 1,
      },
    });
  });

  it('modelUsage が無ければ undefined（0 の行を作らない）', () => {
    expect(modelUsageOf({})).toBeUndefined();
    expect(modelUsageOf({ modelUsage: null })).toBeUndefined();
  });
});

describe('読めなかった欄を数える（Issue #2086。「0」と「取れなかった」を区別する）', () => {
  it('正当な0は読めた値であって unreadable には数えない', () => {
    const models = modelUsageOf({
      modelUsage: {
        opus: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
        },
      },
    });
    expect(models?.opus).toEqual({ ...ZERO_USAGE });
    expect(models?.opus).not.toHaveProperty('unreadable');
  });

  it('数でない・有限でない・負の値は 0 を書きつつ unreadable に1と数える', () => {
    const models = modelUsageOf({
      modelUsage: {
        opus: {
          inputTokens: 'たくさん', // 数でない
          outputTokens: Number.NaN, // 有限でない
          cacheReadInputTokens: -1, // 負
          cacheCreationInputTokens: 0, // 正当な0（読めた）
          webSearchRequests: undefined, // 欠けている
          costUSD: Number.POSITIVE_INFINITY, // 有限でない
        },
      },
    });
    expect(models?.opus).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0,
      unreadable: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        webSearchRequests: 1,
        costUsd: 1,
      },
    });
    // 正当な0（cacheCreationInputTokens）は unreadable に現れない。
    expect(models?.opus?.unreadable).not.toHaveProperty('cacheCreationInputTokens');
  });

  it('入口2つ（result.modelUsage と session.model_usage）のどちらも同じ toModelTotals を通る', () => {
    // 入口1: `modelUsageOf`（result.modelUsage）。
    const fromResult = modelUsageOf({ modelUsage: { opus: { webSearchRequests: 'nope' } } });
    expect(fromResult?.opus?.unreadable?.webSearchRequests).toBe(1);

    // 入口2: `sessionModelUsageOf`（control channel の session.model_usage）。
    const fromSession = sessionModelUsageOf({
      session: { model_usage: { opus: { webSearchRequests: 'nope' } } },
    });
    expect(fromSession?.opus?.unreadable?.webSearchRequests).toBe(1);
  });

  it('数値の出力そのものは変わらない（読めない値は引き続き0を書く）', () => {
    const models = modelUsageOf({ modelUsage: { opus: { inputTokens: -5, outputTokens: 10 } } });
    expect(models?.opus?.inputTokens).toBe(0);
    expect(models?.opus?.outputTokens).toBe(10);
  });

  describe('畳み込み（foldUsageSnapshot / foldOneshotUsage）が unreadable を取りこぼさない', () => {
    it('数値6欄が全部0でも unreadable が在れば「動いていないモデルの行」として消えない', () => {
      // 直す前は isZero が unreadable を見ておらず、この回の delta が
      // `{}` になって記録そのものが消えていた。
      const fold = foldUsageSnapshot(
        null,
        { models: { opus: { ...ZERO_USAGE, unreadable: { webSearchRequests: 1 } } } },
        AT,
      );
      expect(fold.delta).toEqual({
        opus: { ...ZERO_USAGE, unreadable: { webSearchRequests: 1 } },
      });
    });

    it('毎ターン同じ欄が読めないとき、差分ではなく毎回の読みをそのまま delta に渡す（取りこぼさない）', () => {
      // unreadable は SDK の累積値ではなく「この読みが読めたか」という毎回独立の
      // 観測である。after - before で差を取ると2回目以降が0に潰れて消える
      // ——ここでは「毎回そのまま渡す」ことで、2ターンとも1として残ることを見る。
      const first = foldUsageSnapshot(
        null,
        { models: { opus: { ...ZERO_USAGE, costUsd: 1, unreadable: { webSearchRequests: 1 } } } },
        AT,
      );
      expect(first.delta.opus?.unreadable).toEqual({ webSearchRequests: 1 });

      const second = foldUsageSnapshot(
        nextBaseline(first),
        { models: { opus: { ...ZERO_USAGE, costUsd: 2, unreadable: { webSearchRequests: 1 } } } },
        LATER,
      );
      // costUsd は累積の差分（2-1=1）。unreadable は今回の読みそのもの（1）
      // であって、差分(1-1=0)にはならない。
      expect(second.delta.opus).toEqual({
        ...ZERO_USAGE,
        costUsd: 1,
        unreadable: { webSearchRequests: 1 },
      });
    });

    // mgr-712ad619 のレビューで足した。この台帳は「同じ累積を2回送っても増分は 0」
    // （再送に耐える）を約束している。2周目に、1周目が作った基準（`nextBaseline`）を
    // 挟んで、同じスナップショットをもう一度畳む。
    it('同じ累積をもう一度畳む（再送）と、unreadable だけの行を積まない', () => {
      const snapshot = {
        models: { opus: { ...ZERO_USAGE, costUsd: 1, unreadable: { webSearchRequests: 1 } } },
      };
      const first = foldUsageSnapshot(null, snapshot, AT);
      expect(first.delta.opus?.unreadable).toEqual({ webSearchRequests: 1 });

      const resent = foldUsageSnapshot(nextBaseline(first), snapshot, LATER);
      expect(resent.delta).toEqual({});
    });

    it('数値6欄が全部0で基準の在るモデルが、読めないまま再送されても行を積まない', () => {
      const snapshot = { models: { opus: { ...ZERO_USAGE, unreadable: { costUsd: 1 } } } };
      const first = foldUsageSnapshot(null, snapshot, AT);
      expect(first.delta.opus?.unreadable).toEqual({ costUsd: 1 });

      const resent = foldUsageSnapshot(nextBaseline(first), snapshot, LATER);
      expect(resent.delta).toEqual({});
    });

    it('foldOneshotUsage も同じ理由で unreadable-only の行を落とさない', () => {
      const fold = foldOneshotUsage({
        models: { opus: { ...ZERO_USAGE, unreadable: { costUsd: 1 } } },
      });
      expect(fold.delta).toEqual({ opus: { ...ZERO_USAGE, unreadable: { costUsd: 1 } } });
    });
  });
});

describe('行の合計に unreadable を足し込む（Issue #2086）', () => {
  it('片方の行にしか unreadable が無くても、合計にはそのまま現れる', () => {
    const rows: UsageRow[] = [
      {
        date: '2026-08-13',
        managerId: 'm1',
        model: 'opus',
        layer: 'manager',
        site: 'session',
        totals: totals({ costUsd: 1, unreadable: { webSearchRequests: 2 } }),
        updatedAt: AT,
      },
      {
        date: '2026-08-14',
        managerId: 'm2',
        model: 'sonnet',
        layer: 'manager',
        site: 'session',
        totals: totals({ costUsd: 1 }),
        updatedAt: AT,
      },
    ];
    expect(sumUsageRows(rows)).toEqual(
      totals({ costUsd: 2, unreadable: { webSearchRequests: 2 } }),
    );
  });

  it('unreadable を持つ行が1つも無ければ、合計にも欄そのものが無い', () => {
    const rows: UsageRow[] = [
      {
        date: '2026-08-13',
        managerId: 'm1',
        model: 'opus',
        layer: 'manager',
        site: 'session',
        totals: totals({ costUsd: 1 }),
        updatedAt: AT,
      },
    ];
    expect(sumUsageRows(rows)).not.toHaveProperty('unreadable');
  });
});

describe('取れなかった区切りの1行（describeUnreadableUsage。Issue #2086）', () => {
  it('unreadable が無ければ空配列（既存の出力を1文字も変えない）', () => {
    expect(describeUnreadableUsage(totals({ costUsd: 1 }))).toEqual([]);
  });

  it('在れば、欄ごとの回数を値を作らず理由として1行にする', () => {
    const lines = describeUnreadableUsage(totals({ unreadable: { inputTokens: 3, costUsd: 1 } }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('入力 3回');
    expect(lines[0]).toContain('費用 1回');
    expect(lines[0]).not.toContain('出力');
  });
});

describe('読めずに外した行の1文（describeUnreadableUsageRows。Issue #2427）', () => {
  it('欄が無い（古いデーモン）・空配列なら空配列。「0 行」も「undefined 行」も作らない', () => {
    expect(describeUnreadableUsageRows(undefined)).toEqual([]);
    expect(describeUnreadableUsageRows([])).toEqual([]);
  });

  it('在れば、合計に入っていないと言い、内訳と日付を値なしで1文にする', () => {
    expect(
      describeUnreadableUsageRows([
        { table: 'usage_daily', date: '2026-09-27', fields: ['layer'] },
        { table: 'usage_turns', date: '2026-09-27', fields: ['layer'] },
        { table: 'usage_daily', fields: ['site'] },
      ]),
    ).toEqual([
      '⚠ 読めない使用量の行が 3 行あり、合計に入っていない' +
        '（読めない行の値は足していない。合計はその分少ない。' +
        '内訳: 消費量の行 2 行 / 回数の行 1 行。日付: 2026-09-27）。',
    ]);
  });

  it('日付は上限で切り、切った分は数で言う', () => {
    const rows = ['01', '02', '03', '04', '05', '06', '07'].map((day) => ({
      table: 'usage_daily' as const,
      date: `2026-09-${day}`,
      fields: ['layer'],
    }));
    const [line] = describeUnreadableUsageRows(rows);
    expect(line).toContain(
      '日付: 2026-09-01, 2026-09-02, 2026-09-03, 2026-09-04, 2026-09-05 ほか 2 日',
    );
    expect(line).not.toContain('2026-09-06');
  });
});

describe('金額の表示', () => {
  it('$1 未満は 4 桁まで出す（丸めて 0 にしない）', () => {
    // 委譲1本はふつう $1 を大きく下回る。2桁に丸めると `$0.00` になって
    // 「使っていない」と読める。
    expect(formatUsd(0.0031)).toBe('$0.0031');
    expect(formatUsd(0)).toBe('$0.0000');
  });

  it('$1 以上は 2 桁', () => {
    expect(formatUsd(12.3456)).toBe('$12.35');
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

/**
 * 日誌の `tool_use.actor` が「クローン自身の手」かどうかの判定。
 *
 * **判定をここ1本に閉じてあることが要点である。** クローンも道具を全部持つように
 * なった（#32）ので、この判定は digest（委譲の判断材料）・日報・Web UI の
 * 再取得の3か所が読む。層の枝が増えたときに `=== 'clone'` と書き写した箇所が
 * あると、その箇所だけ新しい枝を「委譲した量」の側へ落とす。
 */
describe('クローンの手かどうか（actor の判定）', () => {
  it('クローンの3つの枝はすべて「自分の手」である', () => {
    expect(isCloneActor(CLONE_ACTOR_ID)).toBe(true);
    expect(isCloneActor(`${CLONE_SUB_ACTOR_PREFIX}general-purpose`)).toBe(true);
    expect(isCloneActor(CLONE_DISTILL_ACTOR_ID)).toBe(true);
  });

  it('マネージャーと作業者は「自分の手」ではない', () => {
    expect(isCloneActor('manager:mgr-1234abcd')).toBe(false);
    expect(isCloneActor('worker:mgr-1234abcd:worker')).toBe(false);
    // 台帳側の actor（`mgr-…`）も混ざらない
    expect(isCloneActor('mgr-1234abcd')).toBe(false);
  });

  /**
   * **前方一致は `clone:` まで含めて見る。** `clones-r-us` のような名前を
   * クローン扱いしないこと（区切りを含めずに `startsWith('clone')` で書くと通る）。
   */
  it('名前が clone で始まるだけの別物を拾わない', () => {
    expect(isCloneActor('clones-r-us')).toBe(false);
    expect(isCloneActor('cloneish')).toBe(false);
  });
});

describe('場所の語彙（Issue #486 M7 S7: peer）', () => {
  it('schema は peer を受け入れ、既存の session / distill も変えず、知らない値は弾く', () => {
    expect(usageSiteSchema.options).toEqual(['session', 'distill', 'peer']);
    for (const site of ['session', 'distill', 'peer']) {
      expect(usageSiteSchema.safeParse(site).success).toBe(true);
    }
    expect(usageSiteSchema.safeParse('other').success).toBe(false);
  });
});
