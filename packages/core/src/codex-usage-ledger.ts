import {
  computeCodexRequestsCostUSD,
  isCount,
  type CodexUsageForPricing,
} from './codex-pricing.js';
import type { UsageTotals } from './usage.js';
import type { UsageUnreadableCounts } from './usage-format.js';

export function codexUsageToLedgerTotals(
  model: string | undefined,
  requests: readonly CodexUsageForPricing[],
): UsageTotals {
  const costUsd = computeCodexRequestsCostUSD(model, requests);

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
