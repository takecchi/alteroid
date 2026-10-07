import { describe, expect, it } from 'vitest';

import { computeCodexCostUSD, CODEX_LONG_CONTEXT_THRESHOLD_TOKENS } from './codex-pricing.js';
import { codexUsageToLedgerTotals } from './codex-usage-ledger.js';

const T = CODEX_LONG_CONTEXT_THRESHOLD_TOKENS;
const u = (inputTokens: number, outputTokens = 1000, cachedInputTokens = 0) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningOutputTokens: 0,
  totalTokens: inputTokens + outputTokens,
});

describe('codexUsageToLedgerTotals', () => {
  it('requests: 272K 以下と超えの混在を、リクエストごとの単価で足す', () => {
    const a = u(100_000);
    const b = u(T + 1);
    const r = codexUsageToLedgerTotals('gpt-5.5', { kind: 'requests', requests: [a, b] });
    const short = computeCodexCostUSD('gpt-5.5', a)!;
    const long = computeCodexCostUSD('gpt-5.5', b)!;
    expect(r.costUsd).toBeCloseTo(short + long, 12);
    expect(r.unreadable?.costUsd).toBeUndefined();
    const allShort = ((100_000 + T + 1) * 5 + 2000 * 30) / 1e6;
    expect(r.costUsd).toBeGreaterThan(allShort);
    expect(r.costUsd).not.toBeCloseTo(computeCodexCostUSD('gpt-5.5', u(100_000 + T + 1, 2000))!, 6);
    expect(r.inputTokens).toBe(100_000 + T + 1);
  });

  it('aggregated: 合計が 272K を超え長い側を持つモデルは費用が無い（長い側の値でもない）', () => {
    const agg = u(T + 1, 2000);
    const r = codexUsageToLedgerTotals('gpt-5.5', { kind: 'aggregated', usage: agg });
    expect(r.unreadable?.costUsd).toBe(1);
    expect(r.costUsd).toBe(0);
    expect(r.costUsd).not.toBe(computeCodexCostUSD('gpt-5.5', agg));
    expect(r.inputTokens).toBe(T + 1);
    expect(r.outputTokens).toBe(2000);
  });

  it('aggregated 例外: 272K ちょうどは計算する（どのリクエストも超えられない）', () => {
    const agg = u(T, 2000);
    const r = codexUsageToLedgerTotals('gpt-5.5', { kind: 'aggregated', usage: agg });
    expect(r.costUsd).toBe(computeCodexCostUSD('gpt-5.5', agg));
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.unreadable?.costUsd).toBeUndefined();
  });

  it('aggregated 例外: 長い側を持たないモデルは 272K を超えても計算する', () => {
    const agg = u(T * 3, 2000);
    const r = codexUsageToLedgerTotals('gpt-5.4-mini', { kind: 'aggregated', usage: agg });
    expect(r.costUsd).toBe(computeCodexCostUSD('gpt-5.4-mini', agg));
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it.each([undefined, 'gpt-unknown', 'toString'])(
    'モデル %s は費用が無いがトークン数は残る',
    (model) => {
      for (const input of [
        { kind: 'requests', requests: [u(10, 5, 4)] },
        { kind: 'aggregated', usage: u(10, 5, 4) },
      ] as const) {
        const r = codexUsageToLedgerTotals(model, input);
        expect(r.unreadable?.costUsd).toBe(1);
        expect(r.costUsd).toBe(0);
        expect(r.inputTokens).toBe(6);
        expect(r.cacheReadInputTokens).toBe(4);
        expect(r.outputTokens).toBe(5);
      }
    },
  );

  it('1件でも計算できないリクエストがあれば全体の費用が無い（他の分のトークンは残る）', () => {
    const bad = { ...u(10), inputTokens: Number.NaN };
    const r = codexUsageToLedgerTotals('gpt-5.5', { kind: 'requests', requests: [u(100), bad] });
    expect(r.unreadable?.costUsd).toBe(1);
    expect(r.costUsd).toBe(0);
    expect(r.unreadable?.inputTokens).toBe(1);
    expect(r.outputTokens).toBe(2000);
  });

  it('空の列は費用が無い', () => {
    const r = codexUsageToLedgerTotals('gpt-5.5', { kind: 'requests', requests: [] });
    expect(r.unreadable?.costUsd).toBe(1);
  });

  it('cached / cacheWrite を input の内数として分ける（二重に数えない）', () => {
    const r = codexUsageToLedgerTotals('gpt-6-sol', {
      kind: 'requests',
      requests: [{ ...u(1000, 50, 300), cacheWriteInputTokens: 200 }],
    });
    expect(r).toMatchObject({
      inputTokens: 500,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 200,
      outputTokens: 50,
      webSearchRequests: 0,
    });
    expect(r.unreadable).toEqual({ webSearchRequests: 1 });
  });
});
