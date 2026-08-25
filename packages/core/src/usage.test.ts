import { describe, expect, it } from 'vitest';

import {
  CLONE_ACTOR_ID,
  CLONE_DISTILL_ACTOR_ID,
  CLONE_SUB_ACTOR_PREFIX,
  isCloneActor,
  foldOneshotUsage,
  foldUsageSnapshot,
  isSuccessResult,
  modelUsageOf,
  formatUsd,
  summarizeUsage,
  sumUsageRows,
  type UsageBaseline,
  usageDate,
  type UsageFold,
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
    // SDK の型コメント: 「each result carries the running total so far, so read the
    // latest result rather than summing across results」。ここを足すとターン数だけ
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
    const summary = summarizeUsage(rows);
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
    const summary = summarizeUsage(rows);
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
    const summary = summarizeUsage([
      { ...rows[0]!, tokenId: 'tok-a' },
      // 2件目は帰属が無い（プールを使っていない期間の行）。
      rows[1]!,
      { ...rows[2]!, tokenId: 'tok-a' },
    ]);

    // **`null` が消えていない。** 消えると byToken の合計だけが 0.25 少なくなり、
    // しかも他の軸は「出てこない値を 0 で補わない」約束なので、読み手には
    // 足りないことに気づく手がかりが無い。
    expect(summary.byToken).toEqual([
      { tokenId: 'tok-a', totals: totals({ costUsd: 3 }) },
      { tokenId: null, totals: totals({ costUsd: 0.25 }) },
    ]);
  });

  it('トークンの軸は id の昇順で、帰属の無い分が最後に来る', () => {
    const summary = summarizeUsage([
      rows[0]!,
      { ...rows[1]!, tokenId: 'tok-b' },
      { ...rows[2]!, tokenId: 'tok-a' },
    ]);

    expect(summary.byToken.map((entry) => entry.tokenId)).toEqual(['tok-a', 'tok-b', null]);
  });

  it('プールを使っていない構成では、トークンの軸は null の1件だけになる', () => {
    // **これを「1本のトークンで全部使った」と読ませないための形である。**
    // 要素が1つしか無いことは、`tokensSince` が null であることと合わせて
    // 初めて「取れていない」と読める（口の側がその2つを並べて出す）。
    const summary = summarizeUsage(rows);
    expect(summary.byToken).toEqual([{ tokenId: null, totals: summary.total }]);
  });

  it('空なら全部空', () => {
    const summary = summarizeUsage([]);
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
    const summary = summarizeUsage(rows);
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
    const summary = summarizeUsage(rows);
    expect(summary.byModel).toEqual([{ model: 'opus', totals: totals({ costUsd: 4 }) }]);
    expect(summary.byLayer.map((entry) => entry.layer)).toEqual(['clone', 'manager']);
  });

  it('記録の無い層・場所を 0 で補わない', () => {
    // 「使っていない」と「記録が無い」は別である。行に現れなかった値は一覧に出ない。
    const summary = summarizeUsage(rows.filter((row) => row.layer === 'clone'));
    expect(summary.byLayer).toEqual([{ layer: 'clone', totals: totals({ costUsd: 2 }) }]);
    expect(summary.bySite.map((entry) => entry.site)).toEqual(['distill', 'session']);

    const onlySession = summarizeUsage(rows.filter((row) => row.site === 'session'));
    expect(onlySession.bySite).toEqual([{ site: 'session', totals: totals({ costUsd: 3.5 }) }]);
  });

  it('層でも場所でも、足し上げれば合計に一致する（口ごとに食い違わない）', () => {
    const summary = summarizeUsage(rows);
    for (const axis of [summary.byLayer, summary.bySite]) {
      const sum = axis.reduce((acc, entry) => acc + entry.totals.costUsd, 0);
      expect(sum).toBeCloseTo(summary.total.costUsd, 10);
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
    expect(models?.opus).toEqual({ ...ZERO_USAGE, costUsd: 0.1 });
  });

  it('modelUsage が無ければ undefined（0 の行を作らない）', () => {
    expect(modelUsageOf({})).toBeUndefined();
    expect(modelUsageOf({ modelUsage: null })).toBeUndefined();
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
