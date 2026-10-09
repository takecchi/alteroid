import { describe, expect, it } from 'vitest';

import {
  CODEX_LONG_CONTEXT_THRESHOLD_TOKENS,
  CODEX_PRICING,
  computeCodexCostUSD,
  type CodexUsageForPricing,
} from './codex-pricing.js';
import { CODEX_DEFAULT_PEER_MODELS, CODEX_PROVIDER } from './codex-provider.js';

const usage = (over: Partial<CodexUsageForPricing> = {}): CodexUsageForPricing => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  ...over,
});

describe('CODEX_DEFAULT_PEER_MODELS', () => {
  it('どれも単価表に在る（費用を「単価不明」にしない）', () => {
    for (const model of CODEX_DEFAULT_PEER_MODELS) {
      expect(Object.hasOwn(CODEX_PRICING, model), model).toBe(true);
    }
  });

  it('Codex の記述子が持つ既定の一覧はこの定数である', () => {
    expect(CODEX_PROVIDER.defaultPeerModels).toBe(CODEX_DEFAULT_PEER_MODELS);
  });
});

describe('computeCodexCostUSD', () => {
  it('既知のモデルで入力と出力を単価どおりに計算する', () => {
    const cost = computeCodexCostUSD(
      'gpt-5',
      usage({ inputTokens: 1_000_000, outputTokens: 100_000 }),
    );
    expect(cost).toBeCloseTo(1.25 + 1, 10);
  });

  it('キャッシュ済み入力は input の内数で、割引単価になる', () => {
    const cost = computeCodexCostUSD(
      'gpt-5',
      usage({ inputTokens: 1_000_000, cachedInputTokens: 800_000 }),
    );
    expect(cost).toBeCloseTo(0.25 + 0.1, 10);
  });

  it('reasoning は output の内数なので足さない', () => {
    const base = computeCodexCostUSD('gpt-5', usage({ outputTokens: 1_000_000 }));
    const withReasoning = computeCodexCostUSD(
      'gpt-5',
      usage({ outputTokens: 1_000_000, reasoningOutputTokens: 700_000, totalTokens: 1_000_000 }),
    );
    expect(withReasoning).toBe(base);
    expect(base).toBeCloseTo(10, 10);
  });

  it('cached が input を超えていても負にならない', () => {
    const cost = computeCodexCostUSD('gpt-5', usage({ inputTokens: 100, cachedInputTokens: 500 }));
    expect(cost).toBeCloseTo((100 * 0.125) / 1_000_000, 12);
  });

  it('モデルが分からなければ undefined を返す（既定のモデルを仮定しない）', () => {
    const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(computeCodexCostUSD(undefined, u)).toBeUndefined();
  });

  it('表に無いモデルでは undefined を返す（推測しない）', () => {
    expect(computeCodexCostUSD('gpt-nope', usage({ inputTokens: 10 }))).toBeUndefined();
    expect(computeCodexCostUSD('gpt-5-2025-08-07', usage({ inputTokens: 10 }))).toBeUndefined();
    expect(computeCodexCostUSD('gpt-5-pro', usage({ inputTokens: 10 }))).toBeUndefined();
    expect(computeCodexCostUSD('', usage({ inputTokens: 10 }))).toBeUndefined();
    expect(computeCodexCostUSD('toString', usage({ inputTokens: 10 }))).toBeUndefined();
  });

  it('使用量がゼロなら 0', () => {
    expect(computeCodexCostUSD('gpt-5', usage())).toBe(0);
  });

  it('数として読めない使用量では undefined', () => {
    expect(computeCodexCostUSD('gpt-5', usage({ inputTokens: Number.NaN }))).toBeUndefined();
    expect(computeCodexCostUSD('gpt-5', usage({ outputTokens: -1 }))).toBeUndefined();
    expect(
      computeCodexCostUSD('gpt-5', usage({ cachedInputTokens: Number.POSITIVE_INFINITY })),
    ).toBeUndefined();
  });

  it('入力が閾値ちょうどなら短い側、超えれば長い側の単価になる', () => {
    const at = computeCodexCostUSD(
      'gpt-5.5',
      usage({ inputTokens: CODEX_LONG_CONTEXT_THRESHOLD_TOKENS, outputTokens: 1_000_000 }),
    );
    expect(at).toBeCloseTo((CODEX_LONG_CONTEXT_THRESHOLD_TOKENS * 5) / 1_000_000 + 30, 10);
    const over = computeCodexCostUSD(
      'gpt-5.5',
      usage({
        inputTokens: CODEX_LONG_CONTEXT_THRESHOLD_TOKENS + 1,
        cachedInputTokens: 100_000,
        outputTokens: 1_000_000,
      }),
    );
    expect(over).toBeCloseTo(
      ((CODEX_LONG_CONTEXT_THRESHOLD_TOKENS + 1 - 100_000) * 10 + 100_000 * 1) / 1_000_000 + 45,
      10,
    );
  });

  it('長い側の単価を持たないモデルは、閾値を超えても短い側のまま', () => {
    const cost = computeCodexCostUSD('gpt-5', usage({ inputTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(1.25, 10);
  });

  it('キャッシュ書き込みは非キャッシュ入力の内数として書き込み単価で課金する', () => {
    const cost = computeCodexCostUSD(
      'gpt-6.1-sol',
      usage({ inputTokens: 200_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 40_000 }),
    );
    expect(cost).toBeCloseTo(0.12 + 0.1 + 0.01, 10);
  });

  it('書き込み単価の無いモデルでは書き込みを入力単価で課金する', () => {
    const cost = computeCodexCostUSD(
      'gpt-5',
      usage({ inputTokens: 1_000_000, cacheWriteInputTokens: 400_000 }),
    );
    expect(cost).toBeCloseTo(1.25, 10);
  });

  it('表の単価が正の有限値で、長い側が短い側より安くない', () => {
    for (const [model, p] of Object.entries(CODEX_PRICING)) {
      expect(p.input, model).toBeGreaterThan(0);
      expect(p.output, model).toBeGreaterThan(0);
      if (p.cachedInput !== undefined) expect(p.cachedInput, model).toBeLessThan(p.input);
      if (p.long) {
        expect(p.long.input, model).toBeGreaterThanOrEqual(p.input);
        expect(p.long.output, model).toBeGreaterThanOrEqual(p.output);
      }
    }
  });
});
