import {
  fetchAccountUsage,
  type AccountUsage,
  type AccountUsageState,
  type LimitsUnavailableCause,
  type UsageWindow,
} from './usage-snapshot.js';
import type { UsageProbeQuery } from './usage-probe.js';

// 判定材料が足りないことを unusable へ丸めず undecidable を持つ: 誤ると使えるトークンを捨てるため
export type TokenCandidateVerdict =
  | { verdict: 'usable' }
  | { verdict: 'unusable'; reason: string; retryAt?: number }
  | { verdict: 'undecidable'; reason: string };

// rate_limit_event の rejected で判定しない: probe はターンを回さず届かないため
export const EXHAUSTED_UTILIZATION = 100;

function isExhausted(window: UsageWindow): boolean {
  // utilization が付かない枠は使い切りに数えない: 取れなかったものを 100 で埋める嘘になるため
  return window.utilization !== undefined && window.utilization >= EXHAUSTED_UTILIZATION;
}

function extraUsageUsable(extra: NonNullable<AccountUsage['extraUsage']>): boolean {
  if (!extra.enabled) return false;
  if (extra.utilization !== undefined && extra.utilization >= EXHAUSTED_UTILIZATION) return false;
  return true;
}

function describeUnavailableHead(cause: LimitsUnavailableCause | undefined): string {
  switch (cause) {
    case 'not_logged_in':
      return 'まだ鍵が届いていないので枠が取れない';
    case 'non_first_party':
      return 'この認証では原理的に枠が取れない';
    case 'undetermined':
      return '枠が返ってこないが、その理由を言い分けられない';
    // default を消さない: 版のずれで cause が無い回の実行時の倒れ先が要るため
    default:
      return '枠が返ってこない構成である（理由の欄が付いていない）';
  }
}

export function judgeTokenCandidate(state: AccountUsageState): TokenCandidateVerdict {
  if (state.state === 'unknown') {
    return { verdict: 'undecidable', reason: 'まだ observe していない（unknown）' };
  }
  if (state.state === 'failed') {
    return {
      verdict: 'undecidable',
      reason: `probe が失敗した。認証失敗・通信断・締め切りが区別できない形で混ざる（reason: ${state.reason}）`,
    };
  }
  if (state.state === 'unavailable') {
    return {
      verdict: 'undecidable',
      reason: `${describeUnavailableHead(state.cause)}（reason: ${state.reason}）`,
    };
  }

  if (state.usage.windows.length === 0) {
    return {
      verdict: 'undecidable',
      reason: '枠を1つも取れなかった（空は 0% ではなく「取れなかった」）',
    };
  }

  const allWindowsExhausted = state.usage.windows.every(isExhausted);
  if (!allWindowsExhausted) {
    return { verdict: 'usable' };
  }

  // extraUsage が undefined でも unusable へ倒さない: 取れなかったことを根拠に候補を1本捨てることになるため
  const extra = state.usage.extraUsage;
  if (extra === undefined) {
    return {
      verdict: 'undecidable',
      reason:
        '取れた枠は全部使い切っているが、課金枠が取れなかった' +
        '（取れなかったことを「課金枠が無い」と読まない）',
    };
  }
  if (extraUsageUsable(extra)) {
    return { verdict: 'usable' };
  }

  const resetTimes = state.usage.windows
    .map((w) => w.resetsAt)
    .filter((v): v is number => v !== undefined);
  const retryAt = resetTimes.length > 0 ? Math.max(...resetTimes) : undefined;

  return {
    verdict: 'unusable',
    reason: '取れた枠がすべて使い切られており、課金枠も使えない',
    ...(retryAt !== undefined ? { retryAt } : {}),
  };
}

// options.token を返り値・例外・ログに入れない: fetchAccountUsage の env へ渡す以外に使わない
// 認証 env の名前を列挙して他の資格を落とさない: SDK が名前を足すたびに静かに穴が開くため。
// tokenSource で出所を検査しない: 「tokenSource?: string」 [sdk-verbatim AccountInfo.tokenSource]（自由文字列）で取りうる値を宣言していないため
export async function probeTokenCandidate(
  queryFn: UsageProbeQuery,
  options: {
    cwd: string;
    token: string;
    signal?: AbortSignal;
    withheldEnvKeys?: readonly string[];
  },
): Promise<TokenCandidateVerdict> {
  const state = await fetchAccountUsage(queryFn, {
    cwd: options.cwd,
    signal: options.signal,
    env: { CLAUDE_CODE_OAUTH_TOKEN: options.token },
    withheldEnvKeys: options.withheldEnvKeys,
  });
  return judgeTokenCandidate(state);
}
