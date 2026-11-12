export type ResumeRecoveryOutcome = 'recovered' | 'unresumable' | 'not-a-resume-failure';

export function decideResumeRecoveryOutcome(input: {
  readonly progressed: boolean;
  readonly record: string | null;
}):
  | { readonly outcome: 'not-a-resume-failure' }
  | { readonly outcome: 'unresumable' }
  | { readonly outcome: 'recovered'; readonly record: string } {
  if (input.progressed) return { outcome: 'not-a-resume-failure' };
  return input.record === null
    ? { outcome: 'unresumable' }
    : { outcome: 'recovered', record: input.record };
}

export interface ResumeRecoveryHost {
  takeResumeAttempt(): { sessionId: string } | null;
  hasProgressed(): boolean;
  /** まだ `#seed` を消さない: `recovered` に決まった後で `teardownForRecreate` が消す。 */
  renderSeedRecord(): string | null;
  discardCarriedOverWork(): void;
  emitResumeFailed(input: { sessionId: string; reason: string; recovered: boolean }): void;
  teardownForRecreate(): string[];
  pushHandoff(input: {
    sessionId: string;
    reason: string;
    record: string;
    carried: readonly string[];
  }): void;
  openSession(): void;
}

export function recoverFromFailedResume(
  host: ResumeRecoveryHost,
  reason: string,
): ResumeRecoveryOutcome {
  const attempt = host.takeResumeAttempt();
  if (attempt === null) return 'not-a-resume-failure';

  const progressed = host.hasProgressed();
  const record = host.renderSeedRecord();
  const decision = decideResumeRecoveryOutcome({ progressed, record });

  if (decision.outcome === 'not-a-resume-failure') return decision.outcome;

  host.discardCarriedOverWork();

  if (decision.outcome === 'unresumable') {
    host.emitResumeFailed({ sessionId: attempt.sessionId, reason, recovered: false });
    return 'unresumable';
  }

  const carried = host.teardownForRecreate();
  host.emitResumeFailed({ sessionId: attempt.sessionId, reason, recovered: true });
  host.pushHandoff({ sessionId: attempt.sessionId, reason, record: decision.record, carried });
  host.openSession();
  return 'recovered';
}
