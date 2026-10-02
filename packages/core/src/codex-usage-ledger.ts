/**
 * Codex app-server の使用量を、台帳の行の形（`usage.ts` の {@link UsageTotals}）へ写す
 * 純粋な関数（#486 M7 段 S6）。どこからも呼ばない（配線は後続の PR）。
 *
 * **これは Codex 固有の語彙であり、中立の語彙へ漏らさない。** 使うのは `codex-*.ts` だけ。
 *
 * ## `last` の粒度
 *
 * `thread/tokenUsage/updated` の `last` は **最後のモデル呼び出し1回**の使用量である
 * （openai/codex rust-v0.160.0: `core/src/session/turn.rs` が `ResponseEvent::Completed` ごとに
 * `record_observed_response_completed` を呼び、`protocol.rs` の `append_last_usage` が
 * `total += last; last = その1回` とする）。`total` は スレッド全体の累積。
 * よって `last` を通知ごとに集めればリクエスト単位の列になる（`requests` の入口）。
 * `total`、またはターン内で足した値は `aggregated` の入口へ渡すこと。
 *
 * ## 形の約束
 *
 * - 費用が取れないとき（表に無い・モデル不明・足し込みで 272K 超かつ長い側の単価あり・
 *   1件でも計算できないリクエスト）は、`costUsd: 0` と `unreadable.costUsd: 1`
 *   （既存の「読めなかった」の表し方。`toModelTotals` と同じ）。推測で埋めない。
 * - トークン数は費用が取れなくても写す。Codex の `inputTokens` は cached を含む内数なので、
 *   台帳（Claude 流: 入力は cache read / creation を含まない）に合わせて
 *   `inputTokens = input - cached - cacheWrite`、`cacheReadInputTokens = cached`、
 *   `cacheCreationInputTokens = cacheWrite` に分ける（`computeCodexCostUSD` と同じ clamp）。
 * - `reasoningOutputTokens` は `outputTokens` の内数で、台帳に欄が無いので落とす。
 * - app-server は web 検索の回数を報告しないので `webSearchRequests` は 0 かつ unreadable。
 */
import {
  computeCodexAggregatedCostUSD,
  computeCodexRequestsCostUSD,
  type CodexUsageForPricing,
} from './codex-pricing.js';
import type { UsageTotals } from './usage.js';
import type { UsageUnreadableCounts } from './usage-format.js';

export type CodexUsageInput =
  /** リクエスト（モデル呼び出し）ごとの使用量。`last` を通知ごとに集めたもの。 */
  | { kind: 'requests'; requests: readonly CodexUsageForPricing[] }
  /** 足し込んだ使用量（`total`、ターン内の合計など）。リクエスト単位には分けられない。 */
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
