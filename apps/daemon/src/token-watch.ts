import {
  judgeTokenCandidate,
  reasonOf,
  type AccountUsageState,
  type TokenCandidateVerdict,
  type TokenReconsiderReason,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenVerdictOrigin,
} from '@alteroid/core';

// 判断を2箇所に置かない: 設定（`rotateOn`）を見る場所が2つになり、`off` でも回る経路が生まれるため。
export interface TokenRotationWatch {
  poke(reason: TokenReconsiderReason): void;
  // 判定はここに書かず `judgeTokenCandidate` を通す: 別に書くと、片方だけが `undecidable` を `unusable` へ丸める形が作れるため。
  observeAccount(
    state: AccountUsageState,
    measuredBy?: { tokenId: string; generation: number },
  ): void;
  observeTurnSuccess(observedBy: { tokenId?: string; generation?: number } | undefined): void;
  stop(): void;
}

export const TOKEN_WATCH_TICK_MS = 60_000;

// 連打を畳む: `PUT /tokens` の連打で probe を何周も焼かないため。
export const MIN_RECONSIDER_GAP_MS = 5_000;

export interface TokenRotationWatchOptions {
  rotator: TokenRotator;
  onOutcome: (outcome: TokenRotationOutcome) => Promise<void>;
  tickMs?: number;
  minGapMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export function startTokenRotationWatch(options: TokenRotationWatchOptions): TokenRotationWatch {
  const tickMs = options.tickMs ?? TOKEN_WATCH_TICK_MS;
  const minGapMs = options.minGapMs ?? MIN_RECONSIDER_GAP_MS;
  const now = options.now ?? (() => Date.now());

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  // 畳んだ突つきの契機は捨てない: 畳むのは probe を焼かないためで、走っている見直しが終わったら溜まった契機で1回だけやり直す。
  let pending: TokenReconsiderReason | undefined;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  // 落ちたことは `onOutcome` の実装ではなくここで跡を残す: `reconsider` が落ちた回は `onOutcome` へ届かないため。
  function run(
    reason: TokenReconsiderReason,
    current?: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin },
  ): Promise<void> {
    lastStartedAt = now();
    const work = (async () => {
      try {
        const outcome = await options.rotator.reconsider({
          reason,
          ...(current === undefined ? {} : { current }),
        });
        await options.onOutcome(outcome);
      } catch (error) {
        process.stderr.write(
          `alteroidd: 認証トークンの見直し（${reason}）が落ちました: ${reasonOf(error)}\n`,
        );
      }
    })();
    inFlight = work.finally(() => {
      inFlight = null;
      const next = pending;
      pending = undefined;
      if (next !== undefined && !stopped) void run(next);
    });
    return inFlight;
  }

  function poke(reason: TokenReconsiderReason): void {
    if (stopped) return;
    if (inFlight !== null) {
      pending ??= reason;
      return;
    }
    if (now() - lastStartedAt < minGapMs) {
      pending ??= reason;
      return;
    }
    void run(reason);
  }

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      const reason = pending ?? 'tick';
      pending = undefined;
      const work = inFlight ?? run(reason);
      void work.finally(() => {
        schedule();
      });
    }, tickMs);
    timer.unref?.();
  };
  schedule();

  return {
    poke,
    observeAccount: (state: AccountUsageState, measuredBy) => {
      if (stopped) return;
      const verdict = judgeTokenCandidate(state);
      if (inFlight !== null) {
        // 判定は捨てて契機だけ溜める: 古い probe の結果を後から効かせないため。
        pending ??= 'account_probe';
        return;
      }
      void run('account_probe', {
        verdict,
        origin:
          measuredBy === undefined
            ? { source: 'account_probe' }
            : {
                source: 'account_probe',
                observedBy: { tokenId: measuredBy.tokenId, generation: measuredBy.generation },
              },
      });
    },
    observeTurnSuccess: (observedBy) => {
      if (stopped) return;
      if (observedBy?.tokenId === undefined || observedBy.generation === undefined) return;
      const origin: TokenVerdictOrigin = {
        source: 'turn_success',
        observedBy: { tokenId: observedBy.tokenId, generation: observedBy.generation },
      };
      if (inFlight !== null) {
        // 溜めずに捨てる: `pending` は `origin`（世代）を運べず、後から `current` 無しで走ると世代の門を素通りして通常の回転判定へ落ちるため。
        return;
      }
      void run('turn_succeeded', { verdict: { verdict: 'usable' }, origin });
    },
    stop,
  };
}
