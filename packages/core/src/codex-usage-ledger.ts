import {
  computeCodexAggregatedCostUSD,
  computeCodexRequestsCostUSD,
  type CodexUsageForPricing,
} from './codex-pricing.js';
import type { UsageTotals } from './usage.js';
import type { UsageUnreadableCounts } from './usage-format.js';

export type CodexUsageInput =
  | { kind: 'requests'; requests: readonly CodexUsageForPricing[] }
  | { kind: 'aggregated'; usage: CodexUsageForPricing };

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export function codexUsageToLedgerTotals(
  model: string | undefined,
  input: CodexUsageInput,
): UsageTotals {
  const requests = input.kind === 'requests' ? input.requests : [input.usage];
  const costUsd =
    input.kind === 'requests'
      ? computeCodexRequestsCostUSD(model, input.requests)
      : computeCodexAggregatedCostUSD(model, input.usage);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let inputUnreadable = false;
  let outputUnreadable = false;
  for (const r of requests) {
    const write = r.cacheWriteInputTokens ?? 0;
    if (!isCount(r.inputTokens) || !isCount(r.cachedInputTokens) || !isCount(write)) {
      inputUnreadable = true;
    } else {
      // input から cached / cacheWrite を引く: Codex の inputTokens は cached を含む内数で、台帳の入力は含まないため
      const cached = Math.min(r.cachedInputTokens, r.inputTokens);
      const uncached = r.inputTokens - cached;
      const written = Math.min(write, uncached);
      inputTokens += Math.floor(uncached - written);
      cacheReadInputTokens += Math.floor(cached);
      cacheCreationInputTokens += Math.floor(written);
    }
    if (!isCount(r.outputTokens)) outputUnreadable = true;
    else outputTokens += Math.floor(r.outputTokens);
  }

  // webSearchRequests は 0 かつ unreadable: app-server が web 検索の回数を報告しないため
  const unreadable: UsageUnreadableCounts = { webSearchRequests: 1 };
  if (inputUnreadable) {
    unreadable.inputTokens = 1;
    unreadable.cacheReadInputTokens = 1;
    unreadable.cacheCreationInputTokens = 1;
  }
  if (outputUnreadable) unreadable.outputTokens = 1;
  if (costUsd === undefined) unreadable.costUsd = 1;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    webSearchRequests: 0,
    costUsd: costUsd ?? 0,
    unreadable,
  };
}
