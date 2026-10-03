import type { AgentEvent } from './agent-events.js';
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from './codex-protocol.js';
import { toRateLimitFacts } from './usage-limits.js';

/**
 * `account/rateLimits/updated`（アカウント単位の枠の更新）→ 中立の `rate_limit` / `usage_notice`（#486 M7 S6）。
 *
 * - 窓（`primary` / `secondary`）ごとに `rate_limit` を1つ。`kind` は `<limitId>.<primary|secondary>`、
 *   `utilization` は `usedPercent`、`resetsAt` は Unix 秒を `toRateLimitFacts` が epoch ms へ直す。
 *   `status` は **100% 以上のときだけ `rejected`**、それ以外は `allowed`（`allowed_warning` は Codex に
 *   閾値が無いので名乗らない）。
 * - `rateLimitReachedType` が付いた（＝止まった・止まる）ときは `usage_notice`（`reached`）を足す。
 *   **報告だけ。provider を切り替える判断はここに無い**（PRD: 枠に当たったらクローンへ知らせる）。
 *   同じ種類の連続した通知は1回にする（`lastReached` を呼び出し側が持つ）。
 * - 更新は疎（欄が省かれうる）。読めない窓は作り物を出さず飛ばす。
 */

function windowEvent(
  limitId: string,
  which: 'primary' | 'secondary',
  window: CodexRateLimitWindow | null | undefined,
): AgentEvent | undefined {
  if (window === null || window === undefined || typeof window.usedPercent !== 'number') {
    return undefined;
  }
  const facts = toRateLimitFacts({
    rateLimitType: `${limitId}.${which}`,
    status: window.usedPercent >= 100 ? 'rejected' : 'allowed',
    utilization: window.usedPercent,
    resetsAt: window.resetsAt ?? undefined,
  });
  return facts === undefined ? undefined : { type: 'rate_limit', facts };
}

export interface CodexRateLimitFold {
  readonly events: AgentEvent[];
  /** 次の呼び出しへ渡す「いま立っている到達の印」（立っていなければ `undefined`）。 */
  readonly reached: string | undefined;
}

export function foldCodexRateLimits(
  snapshot: CodexRateLimitSnapshot,
  previouslyReached: string | undefined,
): CodexRateLimitFold {
  const limitId = snapshot.limitId ?? snapshot.limitName ?? 'codex';
  const events: AgentEvent[] = [];
  for (const [which, window] of [
    ['primary', snapshot.primary],
    ['secondary', snapshot.secondary],
  ] as const) {
    const event = windowEvent(limitId, which, window);
    if (event !== undefined) events.push(event);
  }
  const reachedType =
    typeof snapshot.rateLimitReachedType === 'string'
      ? snapshot.rateLimitReachedType
      : snapshot.spendControlReached === true
        ? 'spend_control_reached'
        : undefined;
  if (reachedType !== undefined && reachedType !== previouslyReached) {
    const resetsAt = [snapshot.primary, snapshot.secondary]
      .filter((w): w is CodexRateLimitWindow => w != null && (w.usedPercent ?? 0) >= 100)
      .map((w) => w.resetsAt)
      .find((r): r is number => typeof r === 'number' && r > 0);
    events.push({
      type: 'usage_notice',
      notice: {
        kind: 'reached',
        text: `Codex の利用枠に達した（${reachedType}、枠 ${limitId}）`,
        ...(resetsAt === undefined
          ? {}
          : { resetsAt: resetsAt > 1e11 ? resetsAt : resetsAt * 1000 }),
      },
    });
  }
  return { events, reached: reachedType };
}
