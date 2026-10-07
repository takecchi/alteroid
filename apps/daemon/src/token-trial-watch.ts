import {
  TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS,
  TOKEN_TRIAL_INTERVAL_MS,
  UnreadableActiveTokenError,
  credentialOf,
  describeTrialFailureFold,
  doubledTrialIntervalMs,
  reasonOf,
  selectTokenForTrial,
  type ActiveAgentToken,
  type AgentToken,
  type Stores,
  type TokenCandidateVerdict,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenTrialPort,
} from '@alteroid/core';

export const TOKEN_TRIAL_WATCH_TICK_MS = 60_000;

// `transition === 'rejected'` だけを見ない: 試しはデーモンの中の1ターンで `#rateLimits` の記憶が書き換わらず、同じ鍵の再拒否は `statusNow: 'rejected'` だけで届くため。
// 世代の照合（`freshness === 'current'`）は要求しない: 古い観測が紛れても間隔が伸びるだけで、倒れる向きは安全側（試す回数が減る）のため。
export function isRejectionForTrialBackoff(observation: {
  transition?: 'entered_overage' | 'rejected';
  statusNow?: string;
  observedBy?: { tokenId?: string };
}): observation is { observedBy: { tokenId: string } } & typeof observation {
  if (observation.observedBy?.tokenId === undefined) return false;
  return observation.transition === 'rejected' || observation.statusNow === 'rejected';
}

export interface TokenTrialWatchOptions {
  stores: Stores;
  trial: TokenTrialPort;
  reconsider: TokenRotator['reconsider'];
  recordTrialVerdict: TokenRotator['recordTrialVerdict'];
  onOutcome: (outcome: TokenRotationOutcome) => Promise<void>;
  now?: () => number;
  tickMs?: number;
  signal?: AbortSignal;
}

export interface TokenTrialWatch {
  noteRejection(tokenId: string, at?: number): void;
  stop(): void;
}

function annotateOutcome(outcome: TokenRotationOutcome, note: string): TokenRotationOutcome {
  if (note === '') return outcome;
  if (outcome.kind === 'rotated') return { ...outcome, why: `${outcome.why}${note}` };
  if (outcome.kind === 'ignored' && outcome.recovered !== undefined) {
    return { ...outcome, why: `${outcome.why}${note}` };
  }
  return outcome;
}

export function startTokenTrialWatch(options: TokenTrialWatchOptions): TokenTrialWatch {
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? TOKEN_TRIAL_WATCH_TICK_MS;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;

  const lastTriedAt = new Map<string, number>();
  const failureCount = new Map<string, number>();
  const intervalOverride = new Map<string, number>();
  const pendingConfirmation = new Map<string, number>();
  let activeUnreadable = false;

  const intervalMsFor = (tokenId: string): number =>
    intervalOverride.get(tokenId) ?? TOKEN_TRIAL_INTERVAL_MS;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  function confirmPendingSuccesses(at: number): void {
    for (const [tokenId, successAt] of pendingConfirmation) {
      if (at - successAt >= TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS) {
        pendingConfirmation.delete(tokenId);
        intervalOverride.delete(tokenId);
      }
    }
  }

  async function handleFailure(
    token: AgentToken,
    verdict: Exclude<TokenCandidateVerdict, { verdict: 'usable' }>,
  ): Promise<void> {
    const count = (failureCount.get(token.id) ?? 0) + 1;
    failureCount.set(token.id, count);
    if (verdict.verdict === 'unusable') {
      await options.recordTrialVerdict({ tokenId: token.id, verdict });
      process.stderr.write(
        `alteroidd: 認証トークンの試し（id ${token.id} / 「${token.label}」）は通らなかった` +
          `（${verdict.reason}）。連続不通過: ${String(count)}\n`,
      );
      return;
    }
    process.stderr.write(
      `alteroidd: 認証トークンの試し（id ${token.id} / 「${token.label}」）は判定できなかった` +
        `（${verdict.reason}）。連続不通過（未判定を含む）: ${String(count)}\n`,
    );
  }

  async function handleSuccess(token: AgentToken): Promise<void> {
    const failedBefore = failureCount.get(token.id) ?? 0;
    failureCount.delete(token.id);
    pendingConfirmation.set(token.id, now());
    const fold = describeTrialFailureFold(failedBefore);

    // 現役かどうかは、いま読み直して決める: 選んだ時点から結果が届くまでに既に回っている可能性があるため。
    // 指名が読めないときは「現役ではない」側へ進む: 既に試し終えたトークンの記録なので、安全に倒せるため。
    let active: ActiveAgentToken | null;
    try {
      active = await options.stores.tokens.readActive();
    } catch (error) {
      if (!(error instanceof UnreadableActiveTokenError)) throw error;
      active = null;
    }
    if (active !== null && active.tokenId === token.id) {
      const outcome = await options.reconsider({
        reason: 'turn_succeeded',
        current: {
          verdict: { verdict: 'usable' },
          origin: {
            source: 'turn_success',
            observedBy: { tokenId: active.tokenId, generation: active.generation },
          },
        },
      });
      await options.onOutcome(annotateOutcome(outcome, fold));
      return;
    }

    await options.recordTrialVerdict({ tokenId: token.id, verdict: { verdict: 'usable' } });
    const outcome = await options.reconsider({ reason: 'trial_succeeded' });
    await options.onOutcome(annotateOutcome(outcome, fold));
  }

  async function runOneTrial(token: AgentToken): Promise<void> {
    lastTriedAt.set(token.id, now());
    let verdict: TokenCandidateVerdict;
    try {
      verdict = await options.trial.trial({ id: token.id, ...credentialOf(token) });
    } catch (error) {
      verdict = { verdict: 'undecidable', reason: reasonOf(error) };
    }
    if (verdict.verdict === 'usable') {
      await handleSuccess(token);
      return;
    }
    await handleFailure(token, verdict);
  }

  async function tickBody(): Promise<void> {
    if (stopped) return;
    const at = now();
    confirmPendingSuccesses(at);
    if (inFlight) return;
    const tokens = await options.stores.tokens.list();
    // 指名が読めないときは `null` を渡さずこの回の試しをやめる: `null` で「指名が無い」と偽装すると、壊れた指名のまま別のトークンを試しうるため。
    let active: ActiveAgentToken | null;
    try {
      active = await options.stores.tokens.readActive();
    } catch (error) {
      if (!(error instanceof UnreadableActiveTokenError)) throw error;
      // 読めないに変わったときだけ書く: 定期処理なので、読めない状態が続くあいだ毎回書くと埋もれるため。
      if (!activeUnreadable) {
        activeUnreadable = true;
        process.stderr.write(
          `alteroidd: 現役の指名が読めない（${reasonOf(error)}）。読めるようになるまで` +
            'トークンの試しを止める。\n',
        );
      }
      return;
    }
    if (activeUnreadable) {
      activeUnreadable = false;
      process.stderr.write(
        'alteroidd: 現役の指名が読めるようになった。トークンの試しを再開する。\n',
      );
    }
    const target = selectTokenForTrial({
      tokens,
      active,
      at,
      lastTriedAt: Object.fromEntries(lastTriedAt),
      intervalMsFor,
    });
    if (target === undefined || target.value === undefined) return;
    inFlight = true;
    try {
      await runOneTrial(target);
    } catch (error) {
      process.stderr.write(`alteroidd: 認証トークンの試しが落ちました: ${reasonOf(error)}\n`);
    } finally {
      inFlight = false;
    }
  }

  // 例外は全部ここで握る: reject のまま出ると `void tick().finally(schedule)` が未処理の拒否になり、デーモンごと落ちるため。
  async function tick(): Promise<void> {
    try {
      await tickBody();
    } catch (error) {
      process.stderr.write(`alteroidd: 認証トークンの試しが落ちました: ${reasonOf(error)}\n`);
    }
  }

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, tickMs);
    timer.unref?.();
  };
  schedule();

  return {
    noteRejection: (tokenId, at) => {
      const when = at ?? now();
      const successAt = pendingConfirmation.get(tokenId);
      if (successAt === undefined) return;
      if (when - successAt > TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS) return;
      pendingConfirmation.delete(tokenId);
      intervalOverride.set(tokenId, doubledTrialIntervalMs(intervalMsFor(tokenId)));
    },
    stop,
  };
}
