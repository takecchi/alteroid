/**
 * 会話の履歴が1ターンの cache_read をどう作るかの式（#5469 P8 前段）。試験専用（本番へ出さない。`context-size-measure.ts` と同じ縛り）。
 *
 * 仕組み: 1ターンの中でモデルへ出す要求は `result.num_turns` 本（道具を 1 回呼ぶたびに 1 本増える）。
 * どの要求にも、その時点の文脈（システムプロンプト + 道具の定義 + 会話の履歴の全部）が載る。prompt cache が効けばほとんどが cache_read になる。よって
 *   1ターンの cache_read ≒ Σ(各要求の文脈) ≒ 要求の本数 N × 平均の文脈 C
 * 文脈は、要約（auto-compact）の直後の床 P から、閾値 T（窓 − 余白）まで、ターンごとに g ずつ伸びて、T に届くと P へ戻る。
 * 伸びが一定なら平均の文脈は C = (P + T) / 2（g に依らない）。要約の周期は (T − P) / g ターン。
 *
 * 入力のうち測れるもの（日誌の turn_timing・turn_usage・context_usage）と、仮定で置くもの（床の内訳）を分けて呼ぶ側が渡す。この関数は式を解くだけで、値を測らない。
 */

export interface HistoryModelInput {
  /** 実測: 1ターンの cache_read の平均（tokens）。 */
  cacheReadPerTurn: number;
  /** 実測: 1 日のターン数。 */
  turnsPerDay: number;
  /** 実測: 1 日の要約（auto-compact）の回数。 */
  compactionsPerDay: number;
  /** 要約の直後の床 P（tokens）。システムプロンプト + 道具 + 要約本文 + 再注入。日誌の `compactions[].postTokens` で実測できる。 */
  floorTokens: number;
  /** 自動の要約の窓（`DEFAULT_AUTO_COMPACT_WINDOW_TOKENS`）。 */
  windowTokens: number;
  /** 窓から閾値までの余白。SDK の既定（1M の窓で約 33K）を使う。日誌の `contextUsage.autoCompactThreshold` で実測できる。 */
  bufferTokens: number;
}

export interface HistoryModel {
  thresholdTokens: number;
  /** 要約から次の要約までのターン数。 */
  cycleTurns: number;
  /** 1ターンで会話の履歴が伸びる量（tokens）。 */
  growthPerTurn: number;
  /** 平均の文脈の大きさ C。 */
  meanContextTokens: number;
  /** 1ターンの要求の本数 N の逆算値 = cacheReadPerTurn / C。 */
  requestsPerTurn: number;
}

export function solveHistoryModel(input: HistoryModelInput): HistoryModel {
  const thresholdTokens = input.windowTokens - input.bufferTokens;
  if (thresholdTokens <= input.floorTokens)
    throw new Error('閾値が床以下: 要約が毎ターン走る形で、式が成り立たない');
  const cycleTurns =
    input.compactionsPerDay === 0 ? Infinity : input.turnsPerDay / input.compactionsPerDay;
  const meanContextTokens = (input.floorTokens + thresholdTokens) / 2;
  return {
    thresholdTokens,
    cycleTurns,
    growthPerTurn: (thresholdTokens - input.floorTokens) / cycleTurns,
    meanContextTokens,
    requestsPerTurn: input.cacheReadPerTurn / meanContextTokens,
  };
}

/**
 * 窓だけを変えたときの 1 ターンの cache_read（伸び g と要求の本数 N は変えない）。
 * 要約そのものの費用（閾値ぶんを 1 回読む）を 1 ターンあたりに均して足す。蒸留・アーカイブの追加の費用と、要約で落ちる細部は入らない。
 */
export function cacheReadWithWindow(
  input: HistoryModelInput,
  base: HistoryModel,
  windowTokens: number,
): { thresholdTokens: number; cycleTurns: number; cacheReadPerTurn: number } {
  const thresholdTokens = windowTokens - input.bufferTokens;
  if (thresholdTokens <= input.floorTokens) throw new Error('閾値が床以下');
  const cycleTurns = (thresholdTokens - input.floorTokens) / base.growthPerTurn;
  const mean = (input.floorTokens + thresholdTokens) / 2;
  return {
    thresholdTokens,
    cycleTurns,
    cacheReadPerTurn: base.requestsPerTurn * mean + thresholdTokens / cycleTurns,
  };
}
