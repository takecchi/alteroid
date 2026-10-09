/**
 * 順序の約束（関数の境界の内側に入ったもの）:
 *
 * > [runner.ts-verbatim #recoverFromFailedResume]
 * > **`close()` を先に、`clear()` を後に。** `#closeWorkerWaitWindow` は
 * > `settled` を「その時点の `#openTasks` が空か」から導く。先に `clear()`
 * > すると、`task-2` が開いたまま resume に失敗した回まで「全員から完了通知を
 * > 受け切った」（`settled: true`）に化ける — 開いたままの委譲を握り潰して
 * > 帳消しにする形になり、`settled: false` の意味（受け切る前に畳まれた）が
 * > 崩れる。先に読ませてから、読み終わった後で捨てる。
 *
 * `recoverFromFailedResume` の中で順序をハードコードするのは、呼び出し側から順序を破れなくするため。
 */

export type ResumeRecoveryOutcome = 'recovered' | 'unresumable' | 'not-a-resume-failure';

export function decideResumeRecoveryOutcome(input: {
  readonly hadAttempt: boolean;
  readonly progressed: boolean;
  readonly record: string | null;
}):
  | { readonly outcome: 'not-a-resume-failure' }
  | { readonly outcome: 'unresumable' }
  | { readonly outcome: 'recovered'; readonly record: string } {
  if (!input.hadAttempt) return { outcome: 'not-a-resume-failure' };
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
  closeWorkerWaitWindow(): void;
  /** 必ず `closeWorkerWaitWindow` の後に呼ぶ（モジュール冒頭の順序の約束）。 */
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
  const decision = decideResumeRecoveryOutcome({ hadAttempt: true, progressed, record });

  if (decision.outcome === 'not-a-resume-failure') return decision.outcome;

  // **`close()` を先に、`clear()` を後に。**
  host.closeWorkerWaitWindow();
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
