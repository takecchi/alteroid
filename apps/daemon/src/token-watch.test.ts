import type {
  AccountUsageState,
  TokenCandidateVerdict,
  TokenEnsureEnvOutcome,
  TokenReconsiderReason,
  TokenRotationOutcome,
  TokenRotator,
  TokenVerdictOrigin,
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
  calls: {
    reason: TokenReconsiderReason;
    current?: { verdict: TokenCandidateVerdict; origin: TokenVerdictOrigin };
  }[];
  outcomes: TokenRotationOutcome[];
  /** `ensureEnvToken` / `reconsider` を呼ばれた順（#832 の順序を測る）。 */
  order: string[];
  ensured: TokenEnsureEnvOutcome[];
  /** `reconsider` を待たせる（重なりの検査で使う）。 */
  hold: (gate: Promise<void>) => void;
}

function fake(): Fake {
  const calls: Fake['calls'] = [];
  const outcomes: TokenRotationOutcome[] = [];
  const order: string[] = [];
  const ensured: TokenEnsureEnvOutcome[] = [];
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
      order.push('reconsider');
      if (gate !== undefined) await gate;
      return ignored;
    },
    restore: () => Promise.resolve({ kind: 'none' as const, why: '' }),
    ensureEnvToken: () => {
      order.push('ensureEnvToken');
      return Promise.resolve({ kind: 'added' as const, tokenId: 'tok-env', why: '行を足した' });
    },
  } satisfies TokenRotator;
  return {
    rotator,
    calls,
    outcomes,
    order,
    ensured,
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
    expect(f.calls[0]?.current?.verdict.verdict).toBe('unusable');
    // **身元を運ばない観測**（`account_probe` は世代を照合しない）。
    expect(f.calls[0]?.current?.origin).toEqual({ source: 'account_probe' });
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
    // **判定は付いていない**（記録だけで判定し直す）。
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

    // **2本目は無い。** `pending` は `TokenReconsiderReason` しか運べないので、
    // ここで溜めると `current`（＝世代）の落ちた `'turn_succeeded'` が後から
    // 走る。その形は `reconsider` の世代の門も「成功では回さない」分岐も
    // 素通りして**通常の回転判定へ落ちる** —— 成功が回す契機に化ける。
    expect(f.calls).toHaveLength(1);
    expect(f.calls.map((call) => call.reason)).toEqual(['startup']);
  });
});

/**
 * **プールが空→1本目になった回に、器の環境変数の行を生やす**（#832）。
 *
 * ## なぜこの歯が要るか
 *
 * `ensureEnvToken` は**プールが空なら足さない**（受け入れ基準7）。そして呼ばれる
 * のは起動時の1回だけだった ⟹ **新しい器では永久に生えない**（起動時は必ず空で、
 * 人間が1本目を登録するのはその後だからである）。
 *
 * 生えないと、`reconsider` が現役を特定できない —— あちらは
 * `active?.tokenId ?? tokens.find(isEnvToken)?.id` で決めるので、**指名も env 行も
 * 無い器では毎回 `ignored` を返す。** ⟹ 2026-09-07 に足した「記録から回す」安全網
 * （`stranded`）が、**新規の器では最初から丸ごと落ちている。**
 *
 * 実測（2026-09-11、Railway の新しい2器）: どちらも env 行が無く、日誌に
 * `stranded` の行が1件も無かった。
 *
 * ## ⚠️ ここが測るのは「いつ聞くか」だけである
 *
 * 足すかどうかを決めるのは `ensureEnvToken` 自身（空なら足さない・環境変数が
 * 無ければ足さない・行が在れば何もしない）。**判定をここへ書き写さないこと**
 * ——それがこの見張りの分担そのものである。
 */
describe('器の環境変数の行（#832）', () => {
  it('pool_changed では ensureEnvToken を reconsider より先に通す', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      onEnsuredEnvToken: (outcome) => f.ensured.push(outcome),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.poke('pool_changed');
    await settle();
    watch.stop();

    // **順序がこの歯の本体である。** 逆だと、行が足された回の見直しがその行を
    // 見ないまま終わる（1回ぶん遅れる。`index.ts` の起動時と同じ順序）。
    expect(f.order).toEqual(['ensureEnvToken', 'reconsider']);
    expect(f.ensured).toEqual([{ kind: 'added', tokenId: 'tok-env', why: '行を足した' }]);
  });

  it('他の契機では呼ばない（目盛りで毎分、記憶ストアを余分に読まない）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      onEnsuredEnvToken: (outcome) => f.ensured.push(outcome),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    // **プールが空でなくなりうるのは人間が書いた回だけである。**
    for (const reason of ['tick', 'startup', 'runner_connected', 'settings_changed'] as const) {
      watch.poke(reason);
      await settle();
    }
    watch.stop();

    expect(f.order.filter((step) => step === 'ensureEnvToken')).toEqual([]);
    expect(f.ensured).toEqual([]);
  });

  it('報告の口を渡さなくても落ちない（行を足す側は通る）', async () => {
    const f = fake();
    const watch = startTokenRotationWatch({
      rotator: f.rotator,
      onOutcome: () => Promise.resolve(),
      tickMs: 1_000_000,
      minGapMs: 0,
    });

    watch.poke('pool_changed');
    await settle();
    watch.stop();

    expect(f.order).toEqual(['ensureEnvToken', 'reconsider']);
  });
});
