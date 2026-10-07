import { fetchAccountUsage } from '@alteroid/core';
import type { UsageProbeHandle, UsageProbeQuery } from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

import { intervalForState, startUsagePolling } from './usage-poller.js';

function probe(answers: () => { account?: unknown; usage?: unknown }): {
  queryFn: UsageProbeQuery;
  calls: () => number;
} {
  let calls = 0;
  const queryFn: UsageProbeQuery = () => {
    calls += 1;
    const answer = answers();
    const handle: UsageProbeHandle = {
      async *[Symbol.asyncIterator]() {
        /* 何も流れない */
      },
      accountInfo: async () => answer.account,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => answer.usage,
    };
    return handle;
  };
  return { queryFn, calls: () => calls };
}

const LOGGED_IN = {
  account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
  usage: {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: '2026-08-14T15:00:00.000Z' } },
  },
};

const NOT_LOGGED_IN = {
  account: { tokenSource: 'none', apiProvider: 'firstParty' },
  usage: { rate_limits_available: false, rate_limits: null },
};

describe('#681: 聞く間隔は「取れないと分かったか」で決まる', () => {
  const INTERVALS = { normal: 5 * 60_000, unavailable: 30 * 60_000 };
  const at = '2026-09-07T11:42:22.701Z';

  it('言い分けられない回は通常の間隔で聞き続ける（本番がこれである）', () => {
    expect(
      intervalForState(
        {
          state: 'unavailable',
          at,
          reason: '枠が効かない理由を言い分けられない…',
          cause: 'undetermined',
        },
        INTERVALS,
      ),
    ).toBe(INTERVALS.normal);
  });

  it('取れないと分かった2つの理由は、長い間隔へ落ちる（元の意図）', () => {
    for (const cause of ['not_logged_in', 'non_first_party'] as const) {
      expect(
        intervalForState({ state: 'unavailable', at, reason: 'r', cause }, INTERVALS),
        cause,
      ).toBe(INTERVALS.unavailable);
    }
  });

  it('理由の欄が無い回（版がずれた応答）は聞き続ける側へ倒す', () => {
    expect(intervalForState({ state: 'unavailable', at, reason: 'r' }, INTERVALS)).toBe(
      INTERVALS.normal,
    );
  });

  it('unavailable 以外はすべて通常の間隔（取れた / まだ / 失敗した）', () => {
    for (const state of [
      { state: 'unknown' } as const,
      { state: 'failed', at, reason: 'probe が応答しなかった' } as const,
    ]) {
      expect(intervalForState(state, INTERVALS), state.state).toBe(INTERVALS.normal);
    }
  });

  it('知らない状態・知らない理由は、型では弾かれ、実行時は聞き続ける側へ倒れる', () => {
    // @ts-expect-error 知らない状態は型で弾かれる
    const futureState: AccountUsageState = { state: 'future' };
    expect(intervalForState(futureState, INTERVALS)).toBe(INTERVALS.normal);
    // @ts-expect-error 知らない理由は型で弾かれる
    const futureCause: AccountUsageState = {
      state: 'unavailable',
      at,
      reason: 'r',
      cause: 'future',
    };
    expect(intervalForState(futureCause, INTERVALS)).toBe(INTERVALS.normal);
  });

  it('未知の apiProvider でも probe 間隔は通常のまま（本題）', async () => {
    const { queryFn } = probe(() => ({
      account: { apiProvider: 'zz' },
      usage: { rate_limits_available: false, rate_limits: null },
    }));
    const state = await fetchAccountUsage(queryFn, { cwd: '/work' });

    expect(state.state).toBe('unavailable');
    if (state.state !== 'unavailable') return;
    expect(state.cause).toBe('undetermined');

    expect(intervalForState(state, INTERVALS)).toBe(INTERVALS.normal);
  });
});

describe('アカウント全体の利用状況を取り直す', () => {
  it('立ち上げた直後は「まだ分からない」（0 ではない）', () => {
    const { queryFn } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 10_000 });
    expect(poller.state()).toEqual({ state: 'unknown' });
    poller.stop();
  });

  it('取れたら持つ', async () => {
    const { queryFn } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 10_000 });

    const state = await poller.refresh();
    expect(state.state).toBe('ok');
    if (state.state === 'ok') expect(state.usage.plan).toBe('Claude Max');
    poller.stop();
  });

  it('一時的に取れなくなっても、取れていた値を捨てない', async () => {
    let ok = true;
    const { queryFn } = probe(() => (ok ? LOGGED_IN : { account: undefined, usage: undefined }));
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 10_000 });

    await poller.refresh();
    expect(poller.state().state).toBe('ok');

    ok = false;
    await poller.refresh();
    expect(poller.state().state).toBe('ok');

    poller.stop();
  });

  it('未ログインは「取れない」として持つが、**諦めて止めない**', async () => {
    let loggedIn = false;
    const { queryFn } = probe(() => (loggedIn ? LOGGED_IN : NOT_LOGGED_IN));
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      unavailableIntervalMs: 5,
    });

    const first = await poller.refresh();
    expect(first.state).toBe('unavailable');
    if (first.state === 'unavailable') expect(first.reason).toContain('ログインしていない');

    loggedIn = true;
    await expect.poll(() => poller.state().state, { timeout: 2000 }).toBe('ok');

    poller.stop();
  });

  it('言い分けられない器でも、通常の間隔で聞き直す（30分側へ落ちない）', async () => {
    const UNDETERMINED = {
      account: { apiProvider: 'firstParty', tokenSource: 'oauth' },
      usage: { rate_limits_available: false, rate_limits: null, subscription_type: null },
    };
    let recovered = false;
    const { queryFn } = probe(() => (recovered ? LOGGED_IN : UNDETERMINED));
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 5,
      unavailableIntervalMs: 600_000,
    });

    const first = await poller.refresh();
    expect(first.state).toBe('unavailable');
    if (first.state === 'unavailable') expect(first.cause).toBe('undetermined');

    recovered = true;
    await expect.poll(() => poller.state().state, { timeout: 2000 }).toBe('ok');

    poller.stop();
  });

  it('取得を重ねない（遅い probe でサブプロセスを積み上げない）', async () => {
    const { queryFn, calls } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 10_000 });

    // 起動直後の1回を先に落ち着かせる: 飛んでいる間はこちらの3本も合流し、何本に畳まれたかを数えられないため。
    await poller.refresh();
    const before = calls();

    await Promise.all([poller.refresh(), poller.refresh(), poller.refresh()]);
    expect(calls() - before).toBe(1);

    poller.stop();
  });

  it('止めたら以後取りに行かない', async () => {
    const { queryFn, calls } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 5 });
    await poller.refresh();
    poller.stop();

    const after = calls();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls()).toBe(after);
  });
});

function capturingProbe(): { queryFn: UsageProbeQuery; captured: unknown[] } {
  const captured: unknown[] = [];
  const queryFn: UsageProbeQuery = ({ options }) => {
    captured.push(options);
    const handle: UsageProbeHandle = {
      async *[Symbol.asyncIterator]() {
        /* control channel しか読まない */
      },
      accountInfo: async () => LOGGED_IN.account,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => LOGGED_IN.usage,
    };
    return handle;
  };
  return { queryFn, captured };
}

describe('usage-poller — withheldEnvKeys を fetchAccountUsage まで届ける（#431）', () => {
  it('withheldEnvKeys を渡すと、probe へ渡す Options.env からそのキーが落ちる', async () => {
    const original = process.env.ALTEROID_DATABASE_URL;
    process.env.ALTEROID_DATABASE_URL = 'postgres://usage-poller-431-test-secret';
    try {
      const { queryFn, captured } = capturingProbe();
      const poller = startUsagePolling({
        queryFn,
        cwd: '/work',
        intervalMs: 10_000,
        withheldEnvKeys: ['ALTEROID_DATABASE_URL'],
      });
      await poller.refresh();
      poller.stop();

      expect(captured).toHaveLength(1);
      const options = captured[0] as { env?: Record<string, string | undefined> };
      expect(options.env).toBeDefined();
      expect('ALTEROID_DATABASE_URL' in (options.env ?? {})).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ALTEROID_DATABASE_URL;
      else process.env.ALTEROID_DATABASE_URL = original;
    }
  });

  it('withheldEnvKeys を渡さないと（既定）、Options.env 自体が省略される（#431 が直す前の形）', async () => {
    const { queryFn, captured } = capturingProbe();
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 10_000 });
    await poller.refresh();
    poller.stop();

    const options = captured[0] as Record<string, unknown>;
    expect('env' in options).toBe(false);
  });
});

describe('#2752: 保持は「同じ鍵での一時的な失敗」に限る', () => {
  const KEY_A = { tokenId: 'tok-a', generation: 1 };
  const KEY_B = { tokenId: 'tok-b', generation: 2 };

  it('ok の後に鍵が替わり、新しい鍵で取れなかったら、古い ok を返さない', async () => {
    let ok = true;
    let identity = KEY_A;
    const { queryFn } = probe(() => (ok ? LOGGED_IN : { account: undefined, usage: undefined }));
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      identity: () => identity,
    });

    await poller.refresh();
    expect(poller.state().state).toBe('ok');

    identity = KEY_B;
    ok = false;
    await poller.refresh();
    poller.stop();

    expect(poller.state().state).not.toBe('ok');
  });

  it('鍵が替わったら、取り直す前から古い ok を返さない（0 でも「取れている」でもなく分からない）', async () => {
    let identity = KEY_A;
    const { queryFn } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      identity: () => identity,
    });

    await poller.refresh();
    expect(poller.state().state).toBe('ok');
    identity = KEY_B;
    expect(poller.state()).toEqual({ state: 'unknown' });
    poller.stop();
  });

  it('同じ鍵での失敗は ok を保つが、失敗していること（いつから・理由）を状態に載せる', async () => {
    let ok = true;
    const { queryFn } = probe(() => (ok ? LOGGED_IN : { account: undefined, usage: undefined }));
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      identity: () => KEY_A,
    });

    await poller.refresh();
    const first = poller.state();
    expect(first.state === 'ok' && first.refreshFailure).toBeFalsy();

    ok = false;
    await poller.refresh();
    const after = poller.state();
    expect(after.state).toBe('ok');
    if (after.state !== 'ok') return;
    expect(after.refreshFailure?.reason).toEqual(expect.any(String));
    const since = after.refreshFailure?.since;
    expect(since).toEqual(expect.any(String));

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 5_000);
      await poller.refresh();
    } finally {
      vi.useRealTimers();
    }
    const again = poller.state();
    expect(again.state === 'ok' && again.refreshFailure?.at).not.toBe(since);
    expect(again.state === 'ok' && again.refreshFailure?.since).toBe(since);

    ok = true;
    await poller.refresh();
    poller.stop();
    const recovered = poller.state();
    expect(recovered.state === 'ok' && recovered.refreshFailure).toBeFalsy();
  });
});

describe('usage-poller — 現役のトークンで測る', () => {
  it('env を渡すと、probe へ渡す Options.env にその値が載る', async () => {
    const { queryFn, captured } = capturingProbe();
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'active-key' }),
    });
    await poller.refresh();
    poller.stop();

    const options = captured[0] as { env?: Record<string, string | undefined> };
    expect(options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('active-key');
  });

  it('env が空を返すなら Options.env 自体を作らない（既定の構成を1文字も変えない）', async () => {
    const { queryFn, captured } = capturingProbe();
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      env: () => ({}),
    });
    await poller.refresh();
    poller.stop();

    const options = captured[0] as Record<string, unknown>;
    expect('env' in options).toBe(false);
  });

  it('env は呼ばれるたびに読み直す（構築時に凍らせない）', async () => {
    let key = 'first';
    const { queryFn, captured } = capturingProbe();
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: key }),
    });
    await poller.refresh();
    key = 'second';
    await poller.refresh();
    poller.stop();

    const keys = captured.map(
      (options) => (options as { env?: Record<string, string> }).env?.CLAUDE_CODE_OAUTH_TOKEN,
    );
    expect(keys).toEqual(['first', 'second']);
  });

  it('1回ぶんの観測が終わるたびに onState を呼ぶ（覚えている値ではなく、この回の値）', async () => {
    let ok = true;
    const { queryFn } = probe(() => (ok ? LOGGED_IN : { account: undefined, usage: undefined }));
    const seen: string[] = [];
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      onState: (state) => {
        seen.push(state.state);
      },
    });

    await poller.refresh();
    ok = false;
    await poller.refresh();
    poller.stop();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(['ok', 'failed']);
    expect(poller.state().state).toBe('ok');
  });

  it('#2738: 測り始めた瞬間の身元を、結果と一緒に onState へ渡す（結果が届く頃の現役ではない）', async () => {
    vi.useFakeTimers();
    let identity = { tokenId: 'tok-a', generation: 1 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queryFn: UsageProbeQuery = () => ({
      async *[Symbol.asyncIterator]() {
        /* 何も流れない */
      },
      accountInfo: async () => {
        await gate;
        return LOGGED_IN.account;
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => LOGGED_IN.usage,
    });
    const seen: Array<{ tokenId: string; generation: number } | undefined> = [];
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      identity: () => identity,
      onState: (_state, measuredBy) => {
        seen.push(measuredBy);
      },
    });

    identity = { tokenId: 'tok-b', generation: 2 };
    release();
    try {
      await poller.refresh();
      await vi.advanceTimersByTimeAsync(5);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }

    expect(seen[0]).toEqual({ tokenId: 'tok-a', generation: 1 });
  });

  it('onState が投げてもポーリングを止めない', async () => {
    const { queryFn, calls } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      intervalMs: 10_000,
      onState: () => {
        throw new Error('聞き手が落ちた');
      },
    });

    await poller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await poller.refresh();
    poller.stop();

    expect(calls()).toBe(2);
  });
});
