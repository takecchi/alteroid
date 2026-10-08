import type { AgentEvent } from './agent-events.js';
import type { CodexRateLimitSnapshot, CodexRateLimitWindow } from './codex-protocol.js';
import { toRateLimitFacts } from './usage-limits.js';

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
    // allowed_warning を名乗らない: Codex に閾値が無いため
    status: window.usedPercent >= 100 ? 'rejected' : 'allowed',
    utilization: window.usedPercent,
    resetsAt: window.resetsAt ?? undefined,
  });
  return facts === undefined ? undefined : { type: 'rate_limit', facts };
}

export interface CodexRateLimitFold {
  readonly events: AgentEvent[];
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
