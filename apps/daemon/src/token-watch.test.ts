import type {
  AccountUsageState,
  TokenCandidateVerdict,
  TokenReconsiderReason,
  TokenRotationOutcome,
  TokenRotator,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startTokenRotationWatch } from './token-watch.js';

/**
 * 認証トークンの見張り（`token-watch.ts`）。
 *
 * **測るのは「いつ聞くか」だけである。** 回すかどうか・どれへ回すかは回し手が
 * 持つので、ここでは偽の回し手が「何を何回聞かれたか」を記録する
 * （判定を2箇所へ置かないことがこの分担の目的なので、**判定を測る歯をここへ
 * 置かないこと自体が設計の表明である**）。
 */
interface Fake {
  rotator: TokenRotator;
  calls: { reason: TokenReconsiderReason; currentVerdict?: TokenCandidateVerdict }[];
  outcomes: TokenRotationOutcome[];
  /** `reconsider` を待たせる（重なりの検査で使う）。 */
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
      currentVerdict?: TokenCandidateVerdict;
    }) => {
      calls.push(input);
      if (gate !== undefined) await gate;
      return ignored;
    },
    restore: () => Promise.resolve({ kind: 'none' as const, why: '' }),
    ensureEnvToken: () => Promise.resolve({ kind: 'skipped' as const, why: '' }),
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

/** マイクロタスクを回し切る（`run` は同期では終わらない）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const OK: AccountUsageState = {
  state: 'ok',
  usage: {
    at: '2026-09-07T00:00:00.000Z',
    limitsAvailable: true,
    windows: [{ kind: 'five_hour', utilization: 12 }],
  },
};

/** 取れた枠が全部使い切られていて、課金枠も使えない ⟹ `judgeTokenCandidate` は `unusable`。 */
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

    // **1回だけ。** 落ちた分は目盛りが拾う（`MIN_RECONSIDER_GAP_MS` の doc）。
    expect(f.calls).toHaveLength(1);
  });

  it('走っている最中の突つきは溜めて、終わってから1回だけ拾う', async () => {
    // **畳むのは probe を焼かないためであって、契機を無かったことにするためでは
    // ない。** `PUT /tokens` の直後に見直しが1回走る、がここで保証される。
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

    // 走っている最中に3回突つく。
    watch.poke('pool_changed');
    watch.poke('runner_connected');
    watch.poke('pool_changed');
    f.hold(Promise.resolve());
    open();
    await settle();
    watch.stop();

    // **溜めた分は1回に畳む**（同じ結論を何周も出さない）。最初に溜まった契機が残る。
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

    await new Promise((resolve) => setTimeout(resolve, 40));
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
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(f.calls).toEqual([]);
  });

  it('reconsider が落ちてもタイマーを止めない', async () => {
    // **落ちたことは見張りが跡を残す。** `onOutcome` へ届かない回なので、
    // あちらに任せると「見直しが一度も走っていない」が誰からも見えない。
    const calls: TokenReconsiderReason[] = [];
    const rotator = {
      observe: () =>
        Promise.resolve({ kind: 'ignored' as const, signal: 'none' as const, why: '' }),
      reconsider: (input: { reason: TokenReconsiderReason }) => {
        calls.push(input.reason);
        return Promise.reject(new Error('落ちた'));
      },
      restore: () => Promise.resolve({ kind: 'none' as const, why: '' }),
      ensureEnvToken: () => Promise.resolve({ kind: 'skipped' as const, why: '' }),
    } satisfies TokenRotator;
    const watch = startTokenRotationWatch({
      rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      minGapMs: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
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
    expect(f.calls[0]?.currentVerdict?.verdict).toBe('unusable');
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

    expect(f.calls[0]?.currentVerdict).toEqual({ verdict: 'usable' });
  });

  it('probe が失敗した観測は undecidable として渡る（unusable へ丸めない）', async () => {
    // **器が混んでいる回に現役を冷却へ入れてしまわない**ことが、この経路で
    // いちばん重要な性質である（`judgeTokenCandidate` の「迷ったら unusable に
    // しない」）。
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

    expect(f.calls[0]?.currentVerdict?.verdict).toBe('undecidable');
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
    // **判定は付いていない**（記録だけで判定し直す）。
    expect(f.calls[1]?.currentVerdict).toBeUndefined();
  });
});
