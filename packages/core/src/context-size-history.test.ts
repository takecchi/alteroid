import { describe, expect, it } from 'vitest';

import { DEFAULT_AUTO_COMPACT_WINDOW_TOKENS } from './claude-provider.js';
import { cacheReadWithWindow, solveHistoryModel } from './context-size-history.js';
import type { HistoryModelInput } from './context-size-history.js';

// #5397 の実測（2026-10-27、UTC 1 日）の値。床 86K・余白 33K は仮定（日誌の compactions / autoCompactThreshold で実測する）
const PROD_2026_10_27: HistoryModelInput = {
  cacheReadPerTurn: 710_000,
  turnsPerDay: 1_171,
  compactionsPerDay: 44,
  floorTokens: 86_000,
  windowTokens: DEFAULT_AUTO_COMPACT_WINDOW_TOKENS,
  bufferTokens: 33_000,
};

describe('会話の履歴の式（#5469 P8 前段）', () => {
  it('平均の文脈は (床 + 閾値) / 2 で、伸びの大きさに依らない', () => {
    const model = solveHistoryModel(PROD_2026_10_27);
    expect(model.thresholdTokens).toBe(267_000);
    expect(model.meanContextTokens).toBe(176_500);
    expect(model.requestsPerTurn).toBeCloseTo(4.02, 1);
    expect(model.cycleTurns).toBeCloseTo(26.6, 1);
    expect(model.growthPerTurn).toBeCloseTo(6_800, -2);
    // 要約の回数だけを変える（伸びだけが変わる）と、平均の文脈も要求の本数も動かない
    const slower = solveHistoryModel({ ...PROD_2026_10_27, compactionsPerDay: 22 });
    expect(slower.meanContextTokens).toBe(model.meanContextTokens);
    expect(slower.requestsPerTurn).toBe(model.requestsPerTurn);
    expect(slower.growthPerTurn).toBeLessThan(model.growthPerTurn);
  });

  it('窓を下げると平均の文脈は床に近づき、要約の周期は短くなる。窓を同じにすると元の値に戻る', () => {
    const base = solveHistoryModel(PROD_2026_10_27);
    const same = cacheReadWithWindow(PROD_2026_10_27, base, DEFAULT_AUTO_COMPACT_WINDOW_TOKENS);
    expect(same.cycleTurns).toBeCloseTo(base.cycleTurns, 6);
    // 同じ窓での出力どうしを比べる: 実測（メインループの cache_read）と比べる相手は N × C の項。要約の費用は別の項で、実測の 71万 には入っていない
    expect(same.mainLoopCacheRead).toBeCloseTo(PROD_2026_10_27.cacheReadPerTurn, 3);
    expect(same.compactionCacheRead).toBeCloseTo(base.thresholdTokens / base.cycleTurns, 6);
    expect(same.cacheReadPerTurn).toBeCloseTo(same.mainLoopCacheRead + same.compactionCacheRead, 6);
    const lower = cacheReadWithWindow(PROD_2026_10_27, base, 200_000);
    expect(lower.cycleTurns).toBeLessThan(base.cycleTurns);
    expect(lower.cacheReadPerTurn).toBeLessThan(same.cacheReadPerTurn);
  });

  it('閾値が床以下の入力は式が成り立たないので投げる', () => {
    expect(() => solveHistoryModel({ ...PROD_2026_10_27, windowTokens: 100_000 })).toThrow(
      '閾値が床以下',
    );
  });
});
