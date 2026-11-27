import type { AgentRequestStats } from './agent-events.js';
import type { CodexTokenUsageBreakdown } from './codex-protocol.js';

/** 1ターンぶんの畳み込み途中の状態。リクエストごとの値は持たない（最大と最初の1回だけ）。 */
export interface RequestStatsAccumulator {
  requests: number;
  maxInputTokens: number | undefined;
  first: { input: number | undefined; cached: number | undefined } | undefined;
}

export function newRequestStats(): RequestStatsAccumulator {
  return { requests: 0, maxInputTokens: undefined, first: undefined };
}

// 数でない値・負・小数は読めなかった値として扱う: 0 に倒すと「0 トークンだった」と読めるため
function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** `thread/tokenUsage/updated` の `last`（モデル呼び出し1回ぶん）を1件積む。 */
export function addRequestToStats(
  acc: RequestStatsAccumulator,
  last: CodexTokenUsageBreakdown,
): void {
  const input = readCount(last.inputTokens);
  const cached = readCount(last.cachedInputTokens);
  acc.first ??= { input, cached };
  acc.requests += 1;
  if (input !== undefined && (acc.maxInputTokens === undefined || input > acc.maxInputTokens)) {
    acc.maxInputTokens = input;
  }
}

/** 呼び出しが1回も無かったターンは `undefined`（`requests: 0` の統計を作らない）。 */
export function foldRequestStats(acc: RequestStatsAccumulator): AgentRequestStats | undefined {
  if (acc.requests === 0) return undefined;
  const { first } = acc;
  const ratio =
    first?.input !== undefined && first.input > 0 && first.cached !== undefined
      ? Math.min(1, first.cached / first.input)
      : undefined;
  return {
    requests: acc.requests,
    ...(acc.maxInputTokens === undefined ? {} : { maxInputTokens: acc.maxInputTokens }),
    ...(first?.input === undefined ? {} : { firstRequestInputTokens: first.input }),
    ...(first?.cached === undefined ? {} : { firstRequestCachedInputTokens: first.cached }),
    ...(ratio === undefined ? {} : { firstRequestCacheHitRatio: ratio }),
  };
}
