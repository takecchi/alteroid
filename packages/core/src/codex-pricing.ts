interface CodexRates {
  readonly input: number;
  readonly cachedInput?: number;
  readonly cacheWrite?: number;
  readonly output: number;
}

interface CodexModelPricing extends CodexRates {
  readonly long?: CodexRates;
}

// 1リクエストの入力がこれを超えると、そのリクエスト全体が長い側の単価になる
export const CODEX_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

export const CODEX_PRICING: Readonly<Record<string, CodexModelPricing>> = {
  'gpt-6-astra': {
    input: 10,
    cachedInput: 1,
    cacheWrite: 12.5,
    output: 50,
    long: { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 },
  },
  'gpt-6.1-sol': {
    input: 2,
    cachedInput: 0.1,
    cacheWrite: 2.5,
    output: 10,
    long: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
  },
  'gpt-6-sol': {
    input: 2,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    output: 10,
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 },
  },
  'gpt-6-luna': {
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    long: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 },
  },
  'gpt-5.6-sol': {
    input: 4,
    cachedInput: 0.4,
    cacheWrite: 5,
    output: 20,
    long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 },
  },
  'gpt-5.6-terra': {
    input: 2,
    cachedInput: 0.2,
    cacheWrite: 2.5,
    output: 12,
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 },
  },
  'gpt-5.6-luna': {
    input: 0.2,
    cachedInput: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
    long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  'gpt-5.5': {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    long: { input: 10, cachedInput: 1, output: 45 },
  },
  'gpt-5.4': {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    long: { input: 5, cachedInput: 0.5, output: 22.5 },
  },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.1': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
};

/**
 * `ALTEROID_MANAGER_PEER_CODEX_MODELS` が未設定・空のときに `peer_run` で名指しできる Codex のモデル。
 * 新しいモデルを開くときはここだけを直す。単価表に無いモデルは入れない（費用を「単価不明」にしか出せないため）。
 * 古い帯・安い帯は入れない: 既定で並べると、頼む側が理由なく下の帯を選べる形になるため。
 */
export const CODEX_DEFAULT_PEER_MODELS: readonly string[] = ['gpt-6-astra', 'gpt-6.1-sol'];

export interface CodexUsageForPricing {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  cacheWriteInputTokens?: number;
}

const PER_MILLION = 1_000_000;

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

// モデル名を完全一致で引く: 日付付きの別名などを推測で寄せない。モデルが分からないときに Codex の既定を仮定しない: 既定はサーバーのカタログで変わるため
export function computeCodexCostUSD(
  model: string | undefined,
  usage: CodexUsageForPricing,
): number | undefined {
  // hasOwn で引く: 継承したプロパティ（toString など）を表の行と取り違えないため
  if (model === undefined || !Object.hasOwn(CODEX_PRICING, model)) return undefined;
  const pricing = CODEX_PRICING[model]!;
  const { inputTokens, cachedInputTokens, outputTokens } = usage;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  if (
    !isCount(inputTokens) ||
    !isCount(cachedInputTokens) ||
    !isCount(outputTokens) ||
    !isCount(cacheWriteInputTokens)
  ) {
    return undefined;
  }
  const rates =
    pricing.long && inputTokens > CODEX_LONG_CONTEXT_THRESHOLD_TOKENS ? pricing.long : pricing;
  // cached は input の内数、reasoning は output の内数: 足さず差し引くだけにする（二重に数えないため）。cacheWrite は非キャッシュ入力の内数と仮定している（実機で未確認）
  const cached = Math.min(cachedInputTokens, inputTokens);
  const uncached = inputTokens - cached;
  const written = Math.min(cacheWriteInputTokens, uncached);
  const usd =
    ((uncached - written) * rates.input +
      written * (rates.cacheWrite ?? rates.input) +
      cached * (rates.cachedInput ?? rates.input) +
      outputTokens * rates.output) /
    PER_MILLION;
  return usd;
}

// 1件でも計算できなければ全体を undefined にする: 一部だけの合計を「費用」と名乗らないため
export function computeCodexRequestsCostUSD(
  model: string | undefined,
  requests: readonly CodexUsageForPricing[],
): number | undefined {
  if (requests.length === 0) return undefined;
  let sum = 0;
  for (const request of requests) {
    const cost = computeCodexCostUSD(model, request);
    if (cost === undefined) return undefined;
    sum += cost;
  }
  return sum;
}

// 高い単価に寄せない: 閾値はリクエスト単位で、足し込んだ値からは長い側かどうかを決められないため
export function computeCodexAggregatedCostUSD(
  model: string | undefined,
  aggregated: CodexUsageForPricing,
): number | undefined {
  if (model === undefined || !Object.hasOwn(CODEX_PRICING, model)) return undefined;
  const { long } = CODEX_PRICING[model]!;
  if (long && !(aggregated.inputTokens <= CODEX_LONG_CONTEXT_THRESHOLD_TOKENS)) return undefined;
  return computeCodexCostUSD(model, aggregated);
}
