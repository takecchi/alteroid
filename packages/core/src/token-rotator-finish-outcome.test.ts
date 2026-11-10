import { describe, expect, it } from 'vitest';

import type { AgentToken } from './token-pool.js';
import {
  CANDIDATE_SWEEP_BUDGET_MS,
  exhaustedOutcome,
  parkedOutcome,
  rotatedWhy,
  unreadableTailOf,
  type DescribeStaleRunEnd,
  type EndedStaleRun,
} from './token-rotator-finish-outcome.js';
import type { TokenSpreadResult } from './token-rotator.js';

// `token-rotator-finish-outcome.ts`（`finishSweep` が返す結果の組み立てだけを切り出した同期の純関数）を、入力 → 出力で縛る。
// 呼び元（`finishSweep`）を通した縛りは `token-rotator-finish-sweep-pin.test.ts`。ここは関数を直に呼び、
// 全欄・`why` の全文・欄が `undefined` のとき欄ごと無いこと・引数をそのまま通す参照・各枝を見る。
// 期待の文字列・欄は、切り出した関数の出力を目で読んで確かめたもの（仕様を先に書いたものではない）。
// 時計は読まない（日時は引数の `cooldownUntil` から作る）。

const UNTIL = Date.parse('2026-08-25T04:00:00.000Z');
const UNTIL_ISO = '2026-08-25T04:00:00.000Z';

function row(id: string, label: string, extra: Partial<AgentToken> = {}): AgentToken {
  return { id, label, order: 0, ...extra };
}

const spread: TokenSpreadResult[] = [];
// 渡された引数を文面に出す: 呼び元が何を渡したかを `why` から読めるように
const describeStaleRunEnd: DescribeStaleRunEnd = (ended) =>
  `\n[stale count=${String(ended.count)} identity=${ended.identity?.tokenId ?? 'null'} tokens=${ended.tokens.map((t) => t.id).join(',')}]`;
const ended: EndedStaleRun = {
  count: 3,
  identity: { tokenId: 'old', generation: 2 } as EndedStaleRun['identity'],
};
const pool = [row('a', 'A'), row('b', 'B')];

describe('unreadableTailOf', () => {
  it('理由が無ければ空、在れば世代と理由を出す', () => {
    expect(unreadableTailOf(undefined, 4)).toBe('');
    expect(unreadableTailOf('壊れていた', 4)).toBe(
      '\n**現役の指名が読めなかったので、世代 4 で撒き直した**（壊れていた）',
    );
  });
});

describe('rotatedWhy', () => {
  const base = {
    whyHead: '頭',
    token: row('b', 'B'),
    generation: 7,
    sweep: { stoppedByBudget: false, fellBackToUndecided: false },
    endedStaleRun: null,
    pool,
    activeUnreadableReason: undefined,
    describeStaleRunEnd,
  };

  it('usable: 観測できた', () => {
    expect(rotatedWhy({ ...base, verdict: { verdict: 'usable' } })).toBe(
      '頭。候補「B」は観測できた',
    );
  });

  it('usable: stale の tail と unreadableTail が順に付く（tail には pool が渡る）', () => {
    expect(
      rotatedWhy({
        ...base,
        verdict: { verdict: 'usable' },
        endedStaleRun: ended,
        activeUnreadableReason: '読めない',
      }),
    ).toBe(
      '頭。候補「B」は観測できた\n[stale count=3 identity=old tokens=a,b]' +
        '\n**現役の指名が読めなかったので、世代 7 で撒き直した**（読めない）',
    );
  });

  it('判定できなかった（倒していない）', () => {
    expect(
      rotatedWhy({ ...base, verdict: { verdict: 'undecidable', reason: '決められない' } }),
    ).toBe('頭。候補「B」は判定できなかったので撒いて本番で確かめる（決められない）');
    expect(
      rotatedWhy({
        ...base,
        verdict: { verdict: 'undecidable', reason: '決められない' },
        endedStaleRun: ended,
        activeUnreadableReason: '読めない',
      }),
    ).toBe(
      '頭。候補「B」は判定できなかったので撒いて本番で確かめる（決められない）' +
        '\n[stale count=3 identity=old tokens=a,b]' +
        '\n**現役の指名が読めなかったので、世代 7 で撒き直した**（読めない）',
    );
  });

  it('倒した: 持ち時間を使い切ったときだけ括弧が付く', () => {
    const verdict = { verdict: 'undecidable' as const, reason: '決められない' };
    expect(
      rotatedWhy({
        ...base,
        verdict,
        sweep: { stoppedByBudget: false, fellBackToUndecided: true },
        endedStaleRun: ended,
        activeUnreadableReason: '読めない',
      }),
    ).toBe(
      '頭。**`usable` と確かめられた候補は見つからなかった**ので、判定できなかった候補「B」へ倒した' +
        '——撒いて本番で確かめる（決められない）\n[stale count=3 identity=old tokens=a,b]' +
        '\n**現役の指名が読めなかったので、世代 7 で撒き直した**（読めない）',
    );
    expect(
      rotatedWhy({ ...base, verdict, sweep: { stoppedByBudget: true, fellBackToUndecided: true } }),
    ).toBe(
      '頭。**`usable` と確かめられた候補は見つからなかった**ので、判定できなかった候補「B」へ倒した' +
        `（候補を試す持ち時間（${String(CANDIDATE_SWEEP_BUDGET_MS)}ms）を使い切ったところで倒した）` +
        '——撒いて本番で確かめる（決められない）',
    );
    expect(CANDIDATE_SWEEP_BUDGET_MS).toBe(60_000);
  });

  it('倒していないときは stoppedByBudget だけでは括弧が付かない', () => {
    expect(
      rotatedWhy({
        ...base,
        verdict: { verdict: 'undecidable', reason: 'r' },
        sweep: { stoppedByBudget: true, fellBackToUndecided: false },
      }),
    ).toBe('頭。候補「B」は判定できなかったので撒いて本番で確かめる（r）');
  });

  it('endedStaleRun が null なら describeStaleRunEnd を呼ばない', () => {
    let calls = 0;
    rotatedWhy({
      ...base,
      verdict: { verdict: 'usable' },
      describeStaleRunEnd: () => {
        calls += 1;
        return 'x';
      },
    });
    expect(calls).toBe(0);
  });

  it('同期の関数が throw したら、そのまま同期で伝わる（Promise に包まれない）', () => {
    const boom = new Error('boom');
    expect(() =>
      rotatedWhy({
        ...base,
        verdict: { verdict: 'usable' },
        endedStaleRun: ended,
        describeStaleRunEnd: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
  });
});

describe('parkedOutcome', () => {
  const earliest = { tokenId: 'b', label: 'B', cooldownUntil: UNTIL };
  const base = {
    outgoingId: 'old',
    row: row('b', 'B'),
    generation: 9,
    spread,
    earliest,
    common: { signal: 'stranded' as const },
    whyHead: '頭',
    skipped: '',
    endedStaleRun: null,
    pool,
    activeUnreadableReason: undefined,
    describeStaleRunEnd,
  };

  it('全欄と why の全文（任意の欄は付けない）', () => {
    const out = parkedOutcome(base);
    expect(out).toStrictEqual({
      kind: 'parked',
      fromTokenId: 'old',
      tokenId: 'b',
      label: 'B',
      generation: 9,
      cooldownUntil: UNTIL,
      signal: 'stranded',
      spread,
      why: `頭。**いま通る候補は1本も無い**。いちばん早く戻る「B」を撒いて待つ（${UNTIL_ISO} まで通らない）`,
    });
    expect(Object.keys(out)).not.toContain('cooldownSource');
    expect(out.spread).toBe(spread);
  });

  it('欄が undefined なら欄ごと無い', () => {
    const out = parkedOutcome({ ...base, outgoingId: undefined });
    expect('fromTokenId' in out).toBe(false);
    expect('freshness' in out).toBe(false);
    expect('reason' in out).toBe(false);
  });

  it('cooldownSource・freshness・reason・skipped・tail・unreadableTail が付く', () => {
    const out = parkedOutcome({
      ...base,
      earliest: { ...earliest, cooldownSource: 'quota_reset' },
      common: { signal: 'stale', freshness: 'stale', reason: 'rejected' } as never,
      skipped: '。試した候補「A」はどれも使えなかった',
      endedStaleRun: ended,
      activeUnreadableReason: '読めない',
    });
    expect(out.cooldownSource).toBe('quota_reset');
    expect(out.signal).toBe('stale');
    expect(out.freshness).toBe('stale');
    expect(out.reason).toBe('rejected');
    expect(out.why).toBe(
      `頭。**いま通る候補は1本も無い**。試した候補「A」はどれも使えなかった。` +
        `いちばん早く戻る「B」を撒いて待つ（${UNTIL_ISO} まで通らない）` +
        '\n[stale count=3 identity=old tokens=a,b]' +
        '\n**現役の指名が読めなかったので、世代 9 で撒き直した**（読めない）',
    );
  });

  it('同期の関数が throw したら、そのまま同期で伝わる', () => {
    expect(() =>
      parkedOutcome({
        ...base,
        endedStaleRun: ended,
        describeStaleRunEnd: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow('boom');
  });
});

describe('exhaustedOutcome', () => {
  const common = { signal: 'stranded' as const };
  const earliestB = {
    tokenId: 'b',
    label: 'B',
    cooldownUntil: UNTIL,
    cooldownSource: 'default' as const,
  };
  const ranOut = { kind: 'none' as const, earliest: earliestB, why: 'ranOut の why' };
  const base = {
    sweep: { stoppedByBudget: false, ranOut, unusableLabels: [] as string[] },
    earliest: earliestB as typeof earliestB | undefined,
    activeTokenId: 'a' as string | undefined,
    activeRow: undefined as AgentToken | undefined,
    common,
    skipped: '',
  };

  it('持ち時間を使い切った: earliest を出さず stoppedBy を付ける', () => {
    const out = exhaustedOutcome({
      ...base,
      sweep: { ...base.sweep, stoppedByBudget: true },
      earliest: undefined,
      skipped: '。S',
    });
    expect(out).toStrictEqual({
      kind: 'exhausted',
      stoppedBy: 'budget',
      signal: 'stranded',
      why: `候補を試す持ち時間（60000ms）を使い切った。S`,
    });
  });

  it('いまの鍵より早い（current が無い）: earliest は ranOut の参照のまま、why は「鍵」', () => {
    const out = exhaustedOutcome({ ...base, skipped: '。S' });
    expect(out).toStrictEqual({
      kind: 'exhausted',
      earliest: earliestB,
      signal: 'stranded',
      why: `いま撒いてある鍵のほうが早く戻る（現役を除いた候補の中でいちばん早い「B」は ${UNTIL_ISO}）。遅い鍵へ移すのは改善ではないので撒き直さない。S`,
    });
    expect(out.kind === 'exhausted' && out.earliest).toBe(ranOut.earliest);
    expect('current' in out).toBe(false);
    expect('stoppedBy' in out).toBe(false);
  });

  it('現役の行が冷却中: current を付け、why に現役の名前が入る（cooldownSource が無ければ欄ごと無い）', () => {
    const activeRow = row('a', 'A', { cooldownUntil: UNTIL + 1000 });
    const out = exhaustedOutcome({
      ...base,
      activeRow,
      common: { ...common, freshness: 'fresh' } as never,
    });
    expect(out).toStrictEqual({
      kind: 'exhausted',
      current: { tokenId: 'a', label: 'A', cooldownUntil: UNTIL + 1000 },
      earliest: earliestB,
      signal: 'stranded',
      freshness: 'fresh',
      why: `いま撒いてある「A」のほうが早く戻る（現役を除いた候補の中でいちばん早い「B」は ${UNTIL_ISO}）。遅い鍵へ移すのは改善ではないので撒き直さない`,
    });
    const withSource = exhaustedOutcome({
      ...base,
      activeRow: { ...activeRow, cooldownSource: 'quota_reset' },
    });
    expect(withSource.current).toStrictEqual({
      tokenId: 'a',
      label: 'A',
      cooldownUntil: UNTIL + 1000,
      cooldownSource: 'quota_reset',
    });
  });

  it('現役が冷却中でなければ current は無い', () => {
    const out = exhaustedOutcome({ ...base, activeRow: row('a', 'A') });
    expect('current' in out).toBe(false);
  });

  it('earliest が現役自身: current は付かず、why は「現役自身」', () => {
    const out = exhaustedOutcome({
      ...base,
      activeTokenId: 'b',
      activeRow: row('b', 'B', { cooldownUntil: UNTIL }),
      skipped: '。S',
    });
    expect('current' in out).toBe(false);
    expect(out.why).toBe(
      'いちばん早く戻る候補が現役自身だった（撒き直しても同じ鍵なので、世代だけ増やすことはしない）。S',
    );
  });

  it('earliest が無い: 試した候補が在れば「使い切った」、無ければ ranOut の why、それも無ければ「候補が無い」', () => {
    const noEarliest = { ...base, earliest: undefined };
    const plain = { kind: 'none' as const, why: 'ranOut の why' };
    const a = exhaustedOutcome({
      ...noEarliest,
      sweep: { stoppedByBudget: false, ranOut: plain, unusableLabels: ['X'] },
      skipped: '。S',
    });
    expect(a).toStrictEqual({
      kind: 'exhausted',
      signal: 'stranded',
      why: '試せる候補を使い切った。S',
    });
    expect(
      exhaustedOutcome({
        ...noEarliest,
        sweep: { stoppedByBudget: false, ranOut: plain, unusableLabels: [] },
      }).why,
    ).toBe('ranOut の why');
    expect(
      exhaustedOutcome({
        ...noEarliest,
        sweep: { stoppedByBudget: false, ranOut: undefined, unusableLabels: [] },
      }).why,
    ).toBe('候補が無い');
  });

  it('earliest 引数が undefined でも sweep.ranOut.earliest が在れば欄は出る（打ち切りでないとき）', () => {
    const out = exhaustedOutcome({ ...base, earliest: undefined });
    expect(out.earliest).toBe(earliestB);
    expect(out.why).toBe('ranOut の why');
  });

  it('同期の関数が throw したら、そのまま同期で伝わる', () => {
    const hostile = {
      ...base,
      activeRow: new Proxy(row('a', 'A'), {
        get() {
          throw new Error('boom');
        },
      }),
    };
    expect(() => exhaustedOutcome(hostile)).toThrow('boom');
  });
});
