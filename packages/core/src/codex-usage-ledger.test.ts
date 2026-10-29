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

  // 単価の側（codex-pricing）と同じ「数として読める」の判定: 0 以上の有限の数（整数でなくてよい）
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, '5', undefined])(
    '数として読めない値 %s は、その欄だけを読めない扱いにする',
    (bad) => {
      const input = codexUsageToLedgerTotals('gpt-5.5', {
        kind: 'requests',
        requests: [{ ...u(100, 7), inputTokens: bad as number }],
      });
      expect(input.unreadable?.inputTokens).toBe(1);
      expect(input.unreadable?.outputTokens).toBeUndefined();
      expect(input.outputTokens).toBe(7);
      expect(input.unreadable?.costUsd).toBe(1);
      expect(computeCodexCostUSD('gpt-5.5', { ...u(100, 7), inputTokens: bad as number })).toBe(
        undefined,
      );

      const output = codexUsageToLedgerTotals('gpt-5.5', {
        kind: 'requests',
        requests: [{ ...u(100, 7), outputTokens: bad as number }],
      });
      expect(output.unreadable?.outputTokens).toBe(1);
      expect(output.unreadable?.inputTokens).toBeUndefined();
      expect(output.inputTokens).toBe(100);
      expect(output.unreadable?.costUsd).toBe(1);

      const write = codexUsageToLedgerTotals('gpt-5.5', {
        kind: 'requests',
        requests: [{ ...u(100, 7), cacheWriteInputTokens: bad as number }],
      });
      // cacheWriteInputTokens は省いてよい（undefined は 0 として読む）
      expect(write.unreadable?.inputTokens).toBe(bad === undefined ? undefined : 1);
    },
  );

  it.each([0, 0.5])('0 と端数 %s は数として読む（端数は台帳で切り捨てる）', (n) => {
    const r = codexUsageToLedgerTotals('gpt-5.5', {
      kind: 'requests',
      requests: [
        { ...u(10, 3, 0), inputTokens: 10 + n, cachedInputTokens: n, outputTokens: 3 + n },
      ],
    });
    expect(r.unreadable).toEqual({ webSearchRequests: 1 });
    expect(r.inputTokens).toBe(10);
    expect(r.cacheReadInputTokens).toBe(0);
    expect(r.outputTokens).toBe(3);
    expect(computeCodexCostUSD('gpt-5.5', { ...u(10, 3, 0), inputTokens: 10 + n })).toBeGreaterThan(
      0,
    );
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
