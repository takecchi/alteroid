import type {
  AccountUsageState,
  TokenCandidateVerdict,
  TokenReconsiderReason,
  TokenRotationOutcome,
  TokenRotator,
  TokenVerdictOrigin,
} from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startTokenRotationWatch } from './token-watch.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Fake {
  rotator: TokenRotator;
  calls: {
    reason: TokenReconsiderReason;
    current?: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin };
  }[];
  outcomes: TokenRotationOutcome[];
  hold: (gate: Promise<void>) => void;
}

function fake(): Fake {
  const calls: Fake['calls'] = [];
  const outcomes: TokenRotationOutcome[] = [];
  let gate: Promise<void> | undefined;
  const ignored: TokenRotationOutcome = {
    kind: 'ignored',
    signal: 'none',
    why: '記録の上ではいまの現役が通る',
  };
  const rotator = {
    observe: () => Promise.resolve(ignored),
    reconsider: async (input: {
      reason: TokenReconsiderReason;
      current?: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin };
    }) => {
      calls.push(input);
      if (gate !== undefined) await gate;
      return ignored;
    },
    restore: () => Promise.resolve({ kind: 'none' as const, why: '' }),
    recordTrialVerdict: () => Promise.resolve('unchanged' as const),
  } satisfies TokenRotator;
  return {
    rotator,
    calls,
    outcomes,
    hold: (next) => {
      gate = next;
    },
  };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

const OK: AccountUsageState = {
  state: 'ok',
  usage: {
    at: '2026-09-07T00:00:00.000Z',
    limitsAvailable: true,
    windows: [{ kind: 'five_hour', utilization: 12 }],
  },
};

const EXHAUSTED: AccountUsageState = {
  state: 'ok',
  usage: {
    at: '2026-09-07T00:00:00.000Z',
    limitsAvailable: true,
    windows: [
      { kind: 'five_hour', utilization: 100, resetsAt: Date.parse('2026-09-07T05:00:00Z') },
    ],
    extraUsage: { enabled: false },
  },
};

describe('見張り: 契機を回し手へ渡す', () => {
  it('突ついたら1回聞く（契機がそのまま渡る）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: async (outcome) => {
        f.outcomes.push(outcome);
      },
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.poke('pool_changed');
    await settle();
    watch.stop();

    expect(f.calls).toEqual([{ reason: 'pool_changed' }]);
    expect(f.outcomes).toHaveLength(1);
  });

  it('近すぎる連打は畳む（probe を何周も焼かない）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 60_000,
    });

    watch.poke('pool_changed');
    await settle();
    watch.poke('pool_changed');
    watch.poke('pool_changed');
    await settle();
    watch.stop();

    expect(f.calls).toHaveLength(1);
  });

  it('走っている最中の突つきは溜めて、終わってから1回だけ拾う', async () => {
    const f = fake();
    let open: () => void = () => undefined;
    f.hold(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.poke('startup');
    await settle();
    expect(f.calls).toHaveLength(1);

    watch.poke('pool_changed');
    watch.poke('runner_connected');
    watch.poke('pool_changed');
    f.hold(Promise.resolve());
    open();
    await settle();
    watch.stop();

    expect(f.calls.map((call) => call.reason)).toEqual(['startup', 'pool_changed']);
  });

  it('目盛りで聞く（何も突つかれていなくても）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      minGapMs: 0,
    });

    await vi.advanceTimersByTimeAsync(40);
    watch.stop();

    expect(f.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.calls.every((call) => call.reason === 'tick')).toBe(true);
  });

  it('stop したら以降は聞かない', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      minGapMs: 0,
    });

    watch.stop();
    watch.poke('pool_changed');
    await vi.advanceTimersByTimeAsync(30);

    expect(f.calls).toEqual([]);
  });

  it('reconsider が落ちてもタイマーを止めない', async () => {
    const calls: TokenReconsiderReason[] = [];
    const rotator = {
      observe: () =>
        Promise.resolve({ kind: 'ignored' as const, signal: 'none' as const, why: '' }),
      reconsider: (input: { reason: TokenReconsiderReason }) => {
        calls.push(input.reason);
        return Promise.reject(new Error('落ちた'));
      },
      restore: () => Promise.resolve({ kind: 'none' as const, why: '' }),
      recordTrialVerdict: () => Promise.resolve('unchanged' as const),
    } satisfies TokenRotator;
    const watch = startTokenRotationWatch({
      rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      minGapMs: 0,
    });

    await vi.advanceTimersByTimeAsync(40);
    watch.stop();

    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('見張り: 枠の観測を judgeTokenCandidate へ通す', () => {
  it('使い切っている観測は unusable として渡る', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeAccount(EXHAUSTED);
    await settle();
    watch.stop();

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.reason).toBe('account_probe');
    expect(f.calls[0]?.current?.verdict.verdict).toBe('unusable');
    expect(f.calls[0]?.current?.origin).toEqual({ source: 'account_probe' });
  });

  it('#2738: 測った鍵の身元（measuredBy）は origin.observedBy として回し手へ渡る', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeAccount(EXHAUSTED, { tokenId: 'tok-a', generation: 3 });
    await settle();
    watch.stop();

    expect(f.calls[0]?.current?.origin).toEqual({
      source: 'account_probe',
      observedBy: { tokenId: 'tok-a', generation: 3 },
    });
  });

  it('通る観測は usable として渡る（止まった記録を消す材料になる）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeAccount(OK);
    await settle();
    watch.stop();

    expect(f.calls[0]?.current?.verdict).toEqual({ verdict: 'usable' });
    expect(f.calls[0]?.current?.origin).toEqual({ source: 'account_probe' });
  });

  it('probe が失敗した観測は undecidable として渡る（unusable へ丸めない）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeAccount({ state: 'failed', at: '2026-09-07T00:00:00.000Z', reason: '通信断' });
    await settle();
    watch.stop();

    expect(f.calls[0]?.current?.verdict.verdict).toBe('undecidable');
  });

  it('走っている最中の観測は判定を捨てて契機だけ溜める（古い probe を後から効かせない）', async () => {
    const f = fake();
    let open: () => void = () => undefined;
    f.hold(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.poke('startup');
    await settle();
    watch.observeAccount(EXHAUSTED);
    f.hold(Promise.resolve());
    open();
    await settle();
    watch.stop();

    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toEqual({ reason: 'account_probe' });
    expect(f.calls[1]?.current).toBeUndefined();
  });
});

describe('見張り: ターンの成功を2本目の生産者へ渡す（#681 (1)）', () => {
  it('揃っていれば turn_succeeded で reconsider を呼ぶ（verdict は常に usable）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeTurnSuccess({ tokenId: 'tok-a', generation: 3 });
    await settle();
    watch.stop();

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.reason).toBe('turn_succeeded');
    expect(f.calls[0]?.current).toEqual({
      verdict: { verdict: 'usable' },
      origin: { source: 'turn_success', observedBy: { tokenId: 'tok-a', generation: 3 } },
    });
  });

  it('⚠️ tokenId が欠けていたら何もしない（世代を名乗れない観測は上げない）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeTurnSuccess({ generation: 3 });
    await settle();
    watch.stop();

    expect(f.calls).toEqual([]);
  });

  it('⚠️ generation が欠けていたら何もしない', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeTurnSuccess({ tokenId: 'tok-a' });
    await settle();
    watch.stop();

    expect(f.calls).toEqual([]);
  });

  it('⚠️ observedBy が undefined でも何もしない', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.observeTurnSuccess(undefined);
    await settle();
    watch.stop();

    expect(f.calls).toEqual([]);
  });

  it('⚠️ 走っている最中の成功は溜めずに捨てる（契機だけ溜めると回す契機に化ける）', async () => {
    const f = fake();
    let open: () => void = () => undefined;
    f.hold(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.poke('startup');
    await settle();
    watch.observeTurnSuccess({ tokenId: 'tok-a', generation: 1 });
    f.hold(Promise.resolve());
    open();
    await settle();
    watch.stop();

    expect(f.calls).toHaveLength(1);
    expect(f.calls.map((call) => call.reason)).toEqual(['startup']);
  });
});
