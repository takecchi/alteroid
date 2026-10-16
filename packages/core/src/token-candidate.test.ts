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

  it('unavailable は判定できない（枠が返ってこない ≠ 使えない）', () => {
    const result = judgeTokenCandidate({
      state: 'unavailable',
      at: AT,
      reason: 'この認証では claude.ai の枠が効かない（apiProvider: bedrock）',
      cause: 'non_first_party',
    });
    expect(result.verdict).toBe('undecidable');
  });

  it('undetermined の回に「原理的に取れない」と書かない（判定は undecidable のまま）', () => {
    const result = judgeTokenCandidate({
      state: 'unavailable',
      at: AT,
      reason: '枠が効かない理由を言い分けられない（…）',
      cause: 'undetermined',
    });
    expect(result.verdict).toBe('undecidable');
    if (result.verdict !== 'usable') {
      expect(result.reason).not.toContain('原理的');
      expect(result.reason).toContain('言い分けられない');
    }
  });

  it('理由の欄が無い回（版がずれた応答）も断定しない', () => {
    const result = judgeTokenCandidate({
      state: 'unavailable',
      at: AT,
      reason: '古い版のデーモンが返した文言',
    });
    expect(result.verdict).toBe('undecidable');
    if (result.verdict !== 'usable') expect(result.reason).not.toContain('原理的');
  });

  it('ok かつ windows が空は判定できない（空は 0% ではなく「取れなかった」）', () => {
    const result = judgeTokenCandidate(ok({ windows: [] }));
    expect(result.verdict).toBe('undecidable');
  });

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

  // 2026-10-16 #4732: 以前の期待値は usable（five_hour=100・seven_day=40 を「全部使い切りではない」として固定していた）。
  // five_hour が詰まればモデルを問わず通らないため unusable に変えた。課金枠は enabled: false を足した
  // （課金枠が取れない回は今まで通り undecidable で、unusable へは倒さない）
  it('ok かつ全モデルに効く枠（five_hour）が使い切りなら、seven_day に空きがあっても使えない', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100, resetsAt: Date.parse(AT) }),
          window({ kind: 'seven_day', utilization: 40 }),
        ],
        extraUsage: { enabled: false },
      }),
    );
    expect(result.verdict).toBe('unusable');
    if (result.verdict === 'unusable') {
      expect(result.reason).toContain('five_hour');
      expect(result.reason).toContain('100%');
      expect(result.reason).toContain(AT);
      expect(result.reason).not.toContain('seven_day');
      expect(result.retryAt).toBe(Date.parse(AT));
    }
  });

  it('seven_day だけが使い切りでも使えない', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 10 }),
          window({ kind: 'seven_day', utilization: 100, resetsAt: 7000 }),
        ],
        extraUsage: { enabled: false },
      }),
    );
    expect(result).toEqual({
      verdict: 'unusable',
      reason: expect.stringContaining('seven_day'),
      retryAt: 7000,
    });
  });

  it('全モデルに効く枠が使い切りでも、課金枠が使えるなら使える', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100 }),
          window({ kind: 'seven_day', utilization: 40 }),
        ],
        extraUsage: { enabled: true, utilization: 40 },
      }),
    );
    expect(result.verdict).toBe('usable');
  });

  it('全モデルに効く枠が使い切りで課金枠が取れなければ判定できない（取れなかったことを根拠に捨てない）', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100 }),
          window({ kind: 'seven_day', utilization: 40 }),
        ],
      }),
    );
    expect(result.verdict).toBe('undecidable');
  });

  it('モデル別の枠が1つ使い切りなだけなら使える（全部尽きたときだけ数える）', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 10 }),
          window({ kind: 'seven_day', utilization: 40 }),
          window({ kind: 'seven_day_opus', utilization: 100 }),
        ],
        extraUsage: { enabled: false },
      }),
    );
    expect(result.verdict).toBe('usable');
  });

  it('全モデルに効く枠が空いていて、観測できた枠がモデル別だけ使い切りでも使える', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'seven_day_opus', utilization: 100 }),
          window({ kind: 'seven_day_sonnet', utilization: 100 }),
          window({ kind: 'five_hour', utilization: undefined }),
        ],
        extraUsage: { enabled: false },
      }),
    );
    expect(result.verdict).toBe('usable');
  });

  it('全モデルに効く枠が観測できないなら今まで通り（取れなかった枠を捨てる根拠にしない）', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: undefined }),
          window({ kind: 'seven_day', utilization: undefined }),
        ],
        extraUsage: { enabled: false },
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
    const result = judgeTokenCandidate(
      ok({
        windows: [window({ kind: 'seven_day', utilization: undefined, resetsAt: 12345 })],
      }),
    );
    expect(result.verdict).toBe('usable');
  });

  // 2026-10-16 #4732: 以前の期待値は usable（five_hour=100・seven_day=utilization 無し・課金枠なし）。
  // five_hour が観測できて 100% なので全モデルに効く枠が尽きている。課金枠が取れていないので undecidable（unusable へは倒さない）
  it('使い切った枠と utilization 無しの枠が混在しても、無しの枠のせいで unusable にはならない', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100 }),
          window({ kind: 'seven_day', utilization: undefined, resetsAt: 999 }),
        ],
      }),
    );
    expect(result.verdict).toBe('undecidable');
  });

  it('使い切った枠と utilization 無しの枠が混在し、課金枠も使えないなら、尽きた枠だけを根拠に unusable（無しの枠の resetsAt は retryAt に入れない）', () => {
    const result = judgeTokenCandidate(
      ok({
        windows: [
          window({ kind: 'five_hour', utilization: 100, resetsAt: 1000 }),
          window({ kind: 'seven_day', utilization: undefined, resetsAt: 999999 }),
        ],
        extraUsage: { enabled: false },
      }),
    );
    expect(result).toEqual({ verdict: 'unusable', reason: expect.any(String), retryAt: 1000 });
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

// 閾値そのものの値は固定しない: 保守側へ動かしたくなったときに、挙動が正しいのにテストが赤くなるため
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
