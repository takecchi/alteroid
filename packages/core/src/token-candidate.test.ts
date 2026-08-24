import { describe, expect, it } from 'vitest';

import { EXHAUSTED_UTILIZATION, judgeTokenCandidate } from './token-candidate.js';
import type { AccountUsage, AccountUsageState, UsageWindow } from './usage-snapshot.js';

const AT = '2026-08-24T10:00:00.000Z';

function usage(partial: Partial<AccountUsage>): AccountUsage {
  return {
    at: AT,
    limitsAvailable: true,
    windows: [],
    ...partial,
  };
}

function ok(partial: Partial<AccountUsage>): AccountUsageState {
  return { state: 'ok', usage: usage(partial) };
}

function window(partial: Partial<UsageWindow>): UsageWindow {
  return { kind: 'five_hour', ...partial };
}

describe('judgeTokenCandidate — 規則の表を1行ずつ固定する', () => {
  it('unknown は判定できない', () => {
    expect(judgeTokenCandidate({ state: 'unknown' })).toEqual({
      verdict: 'undecidable',
      reason: expect.any(String),
    });
  });

  it('failed は判定できない（認証失敗・通信断・締め切りが区別できず混ざるため）', () => {
    const result = judgeTokenCandidate({
      state: 'failed',
      at: AT,
      reason: 'probe が応答しなかった（起動失敗・締め切り・中断）',
    });
    expect(result.verdict).toBe('undecidable');
  });

  it('unavailable は判定できない（原理的に取れない ≠ 使えない）', () => {
    const result = judgeTokenCandidate({
      state: 'unavailable',
      at: AT,
      reason: 'この認証では claude.ai の枠が無い（apiProvider: bedrock）',
    });
    expect(result.verdict).toBe('undecidable');
  });

  it('ok かつ windows が空は判定できない（空は 0% ではなく「取れなかった」）', () => {
    const result = judgeTokenCandidate(ok({ windows: [] }));
    expect(result.verdict).toBe('undecidable');
  });

  // **⚠️ このテストは期待値を反転させてある。** 元は「課金枠なしは *使えない*」を
  // 固定していたが、`extraUsage` が undefined なのは「課金枠が無い」ではなく
  // **「取れなかった」**である（`usage-snapshot.ts` の doc）。取れなかったことを
  // 根拠に候補を1本捨てるのは、この関数が掲げている「迷ったら unusable にしない」
  // に反するので、判定を `undecidable` へ寄せた。**テストは消していない。**
  it('ok かつ取れた枠が全部使い切りでも、課金枠が取れなければ判定できない', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [window({ kind: 'five_hour', utilization: 100 })],
      }),
    );
    expect(result.verdict).toBe('undecidable');
  });

  it('ok かつ取れた枠が全部使い切り・課金枠が enabled: false は使えない', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [window({ kind: 'five_hour', utilization: 100 })],
        extraUsage: { enabled: false },
      }),
    );
    expect(result.verdict).toBe('unusable');
  });

  it('ok かつ取れた枠が全部使い切り・課金枠も utilization >= 100 は使えない', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [window({ kind: 'five_hour', utilization: 100 })],
        extraUsage: { enabled: true, utilization: 100 },
      }),
    );
    expect(result.verdict).toBe('unusable');
  });

  it('ok かつ取れた枠が全部使い切りでも、課金枠が使えるなら使える', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [window({ kind: 'five_hour', utilization: 100 })],
        extraUsage: { enabled: true, utilization: 40 },
      }),
    );
    expect(result.verdict).toBe('usable');
  });

  it('ok かつ一部の枠だけ使い切りなら使える（全部使い切りではない）', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100 }),
          window({ kind: 'seven_day', utilization: 40 }),
        ],
      }),
    );
    expect(result.verdict).toBe('usable');
  });

  it('utilization が低い ok は使える', () => {
    const result = judgeTokenCandidate(ok({ windows: [window({ utilization: 10 })] }));
    expect(result.verdict).toBe('usable');
  });
});

describe('judgeTokenCandidate — utilization が付かない枠は「使い切っている」と数えない', () => {
  it('utilization が undefined の枠だけでは「全部使い切り」にならない（undecidable にも倒れない）', () => {
    // resetsAt はあるが utilization が取れなかった枠。0% でも100%でもなく「取れなかった」。
    const result = judgeTokenCandidate(
      ok({
        windows: [window({ kind: 'seven_day', utilization: undefined, resetsAt: 12345 })],
      }),
    );
    // 取れなかった枠を「使い切っている」扱いにしないので isExhausted が false になり、
    // 「全部使い切り」ではないため usable 側へ倒れる。
    expect(result.verdict).toBe('usable');
  });

  it('使い切った枠と utilization 無しの枠が混在しても、無しの枠のせいで unusable にはならない', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100 }),
          window({ kind: 'seven_day', utilization: undefined, resetsAt: 999 }),
        ],
      }),
    );
    // utilization 無しの枠は「使い切っている」に数えられないので、
    // 「取れた枠がすべて使い切っている」の条件を満たさず usable。
    expect(result.verdict).toBe('usable');
  });
});

describe('judgeTokenCandidate — retryAt', () => {
  it('使い切った複数の枠のうち、いちばん遅い resetsAt になる', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100, resetsAt: 1000 }),
          window({ kind: 'seven_day', utilization: 100, resetsAt: 5000 }),
        ],
        // 課金枠は**取れたうえで使えない**。取れなかった場合は undecidable になる
        // ので、retryAt を見るには unusable に落ちる形を作る必要がある。
        extraUsage: { enabled: false },
      }),
    );
    expect(result).toEqual({
      verdict: 'unusable',
      reason: expect.any(String),
      retryAt: 5000,
    });
  });

  it('resetsAt が1つも取れなければ undefined になる（固定値で埋めない）', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [window({ kind: 'five_hour', utilization: 100, resetsAt: undefined })],
        extraUsage: { enabled: false },
      }),
    );
    expect(result.verdict).toBe('unusable');
    expect(result).not.toHaveProperty('retryAt');
  });
});

describe('judgeTokenCandidate — 保守的に倒れる', () => {
  it('判断材料が欠けているとき（unknown/failed/unavailable/空windows）は unusable にならない', () => {
    const inputs: AccountUsageState[] = [
      { state: 'unknown' },
      { state: 'failed', at: AT, reason: '何か失敗した' },
      { state: 'unavailable', at: AT, reason: '未ログイン' },
      ok({ windows: [] }),
    ];
    for (const input of inputs) {
      expect(judgeTokenCandidate(input).verdict).not.toBe('unusable');
    }
  });
});

/**
 * **閾値そのものの値は固定しない。** 元はここで `EXHAUSTED_UTILIZATION` が 100 で
 * あることを assert していたが、それは**閾値を仕様として凍らせる**形だった ——
 * 実装側の doc は「これは閾値による判定であって権威ある合図ではない」と書いており、
 * 値を歯で固定するとその一文が効かなくなる（保守側へ動かしたくなったときに、
 * 挙動が正しいのにテストが赤くなる）。
 *
 * **代わりに境界の *向き* を固定する。** こちらのほうが強い —— 値を変えても通るが、
 * `>=` を `>` に取り違えたら赤くなる（元の形では捕まらなかった側である）。
 */
it('閾値ちょうどは使い切り側、1つ下は使える側（値ではなく境界の向きを固定する）', () => {
  const atThreshold = judgeTokenCandidate(
    ok({
      windows: [window({ kind: 'five_hour', utilization: EXHAUSTED_UTILIZATION })],
      extraUsage: { enabled: false },
    }),
  );
  expect(atThreshold.verdict).toBe('unusable');

  const justBelow = judgeTokenCandidate(
    ok({
      windows: [window({ kind: 'five_hour', utilization: EXHAUSTED_UTILIZATION - 1 })],
      extraUsage: { enabled: false },
    }),
  );
  expect(justBelow.verdict).toBe('usable');
});
