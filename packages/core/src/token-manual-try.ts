import { redactErrorText } from './denial-input-head.js';
import { reasonOf } from './dropped-record.js';
import type { TokenCandidateVerdict } from './token-candidate.js';
import { credentialOf, tokenAvailabilityAt, type AgentToken } from './token-pool.js';
import type { TokenRotationOutcome, TokenRotator } from './token-rotator.js';
import type { TokenTrialPort } from './token-trial.js';

// 自動の試しの 30 分（`TOKEN_TRIAL_INTERVAL_MS`）より短くする: 人間が待っている操作なので。5 分より短くしない: 連打が1回ごとに本物のターンを1本焼くため。
export const MANUAL_TOKEN_TRY_MIN_INTERVAL_MS = 5 * 60 * 1000;

export type ManualTokenTryRefusal = 'disabled' | 'invalidated' | 'no_value';

export type ManualTokenTryResult =
  | { kind: 'not_found' }
  | { kind: 'not_tryable'; cause: ManualTokenTryRefusal }
  | { kind: 'too_soon'; retryAfterSeconds: number }
  | {
      kind: 'passed';
      // 通ったことと冷却を解いたことは別: 冷却中でない鍵は通っても何も書かない
      cooldownCleared: boolean;
      outcome?: TokenRotationOutcome;
    }
  | { kind: 'rejected'; reason: string; cooldownKept: boolean }
  | { kind: 'undecidable'; reason: string };

export interface ManualTokenTry {
  try(tokenId: string): Promise<ManualTokenTryResult>;
}

interface ManualTokenTryOptions {
  listTokens: () => Promise<readonly AgentToken[]>;
  trial: TokenTrialPort;
  recordTrialVerdict: TokenRotator['recordTrialVerdict'];
  recordTrialSuccess: TokenRotator['recordTrialSuccess'];
  onOutcome: (outcome: TokenRotationOutcome) => Promise<void>;
  now?: () => number;
  minIntervalMs?: number;
}

function refusalOf(token: AgentToken, at: number): ManualTokenTryRefusal | undefined {
  const availability = tokenAvailabilityAt(token, at);
  if (availability === 'disabled' || availability === 'invalidated') return availability;
  if (token.value === undefined || token.value.length === 0) return 'no_value';
  return undefined;
}

export function createManualTokenTry(options: ManualTokenTryOptions): ManualTokenTry {
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = options.minIntervalMs ?? MANUAL_TOKEN_TRY_MIN_INTERVAL_MS;

  // 自動の試しの `lastTriedAt`（`startTokenTrialWatch` の中）と共有しない・書き換えない: 手動の試しで自動の試しが後ろへずれると、人間が確かめた鍵ほど自動の再確認が遅れ、既存の見回りを妨げるため。
  // 試しの前に書く: 走っている最中の同じ鍵への2本目も間隔内として断られ、同時に重ならないため。断った回・試せなかった回は書かない: ターンを使っていないため。
  const lastManualTryAt = new Map<string, number>();

  async function settle(token: AgentToken, verdict: TokenCandidateVerdict, at: number) {
    // 冷却中の鍵だけ回し手へ渡す: 冷却中でない鍵の試しが回し手へ入ると、通っても選び直し（reconsider）が走り、「確認として返すだけ」にならないため
    const cooling = tokenAvailabilityAt(token, at) === 'cooling';
    if (verdict.verdict === 'usable') {
      if (!cooling) return { kind: 'passed', cooldownCleared: false } as const;
      const outcome = await options.recordTrialSuccess({ tokenId: token.id });
      await options.onOutcome(outcome);
      return { kind: 'passed', cooldownCleared: true, outcome } as const;
    }
    if (verdict.verdict === 'unusable') {
      // 冷却中でない鍵の拒否を `recordTrialVerdict` へ渡さない: retryAt 付きだと冷却を書き、確認として返すだけの約束が破れるため
      if (cooling) await options.recordTrialVerdict({ tokenId: token.id, verdict });
      return { kind: 'rejected', reason: verdict.reason, cooldownKept: cooling } as const;
    }
    return { kind: 'undecidable', reason: verdict.reason } as const;
  }

  return {
    async try(tokenId) {
      const at = now();
      const token = (await options.listTokens()).find((row) => row.id === tokenId);
      if (token === undefined) return { kind: 'not_found' };
      const refusal = refusalOf(token, at);
      if (refusal !== undefined) return { kind: 'not_tryable', cause: refusal };

      const last = lastManualTryAt.get(tokenId);
      if (last !== undefined && at - last < minIntervalMs) {
        return {
          kind: 'too_soon',
          retryAfterSeconds: Math.ceil((minIntervalMs - (at - last)) / 1000),
        };
      }
      lastManualTryAt.set(tokenId, at);

      const credential = credentialOf(token);
      // 理由は必ず値を伏せてから返す: 試しの理由も投げられた文面も、応答・日誌・画面へそのまま出るため
      const scrub = (text: string): string => redactErrorText(text, process.env, [credential.value]);
      let verdict: TokenCandidateVerdict;
      try {
        verdict = await options.trial.trial({ id: token.id, ...credential });
      } catch (error) {
        verdict = { verdict: 'undecidable', reason: reasonOf(error) };
      }
      if (verdict.verdict !== 'usable') verdict = { ...verdict, reason: scrub(verdict.reason) };
      return settle(token, verdict, at);
    },
  };
}
