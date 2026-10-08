import { parseNoticeResetAt } from './usage-reset-text.js';
import type { AgentToken, CooldownSource } from './token-pool.js';

export type NoticeResetMatch = 'active' | 'stale';

// 24時間: この関数が読める文言は日付付きの形を受けず、24時間以内のどこかを指すものに限られるため
const NOTICE_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;

// Exclude の裏返しを手で持つ: 実行時に権威あるかを判定するには具体の文字列が要るため。
// notice_text / default の行とは比べない: 推測どうしは値の作られ方が同じで偶然一致しうるため
const GUESSED_COOLDOWN_SOURCES: ReadonlySet<CooldownSource> = new Set(['default', 'notice_text']);

function hasAuthoritativeCooldown(
  token: AgentToken,
): token is AgentToken & { cooldownUntil: number; cooldownSource: CooldownSource } {
  return (
    token.cooldownUntil !== undefined &&
    token.cooldownSource !== undefined &&
    !GUESSED_COOLDOWN_SOURCES.has(token.cooldownSource)
  );
}

// ±5分などの許容を足さない: 文言の時刻は分単位までで、それ以上は実測が無いため
function roundDownToMinute(ms: number): number {
  return ms - (ms % 60_000);
}

export interface MatchNoticeResetOptions {
  at: number;
}

// 判定できない回を「世代ずれではない」へ倒さない: undefined は「分からない」であるため
export function matchNoticeResetAgainstPool(
  noticeText: string,
  activeTokenId: string | undefined,
  pool: readonly AgentToken[],
  options: MatchNoticeResetOptions,
): NoticeResetMatch | undefined {
  if (activeTokenId === undefined) return undefined;

  const impliedResetAt = parseNoticeResetAt(noticeText, {
    at: options.at,
    withinMs: NOTICE_RESET_HORIZON_MS,
  });
  if (impliedResetAt === undefined) return undefined;
  const target = roundDownToMinute(impliedResetAt);

  const active = pool.find((token) => token.id === activeTokenId);
  if (
    active !== undefined &&
    hasAuthoritativeCooldown(active) &&
    roundDownToMinute(active.cooldownUntil) === target
  ) {
    return 'active';
  }

  const stale = pool.find(
    (token) =>
      token.id !== activeTokenId &&
      hasAuthoritativeCooldown(token) &&
      roundDownToMinute(token.cooldownUntil) === target,
  );
  return stale === undefined ? undefined : 'stale';
}
