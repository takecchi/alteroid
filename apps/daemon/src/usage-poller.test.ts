import type { UsageProbeHandle, UsageProbeQuery } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startUsagePolling } from './usage-poller.js';

/** control channel だけを持つ偽の probe。**推論は走らせない**（本物と同じ形）。 */
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

describe('アカウント全体の利用状況を取り直す', () => {
  it('立ち上げた直後は「まだ分からない」（0 ではない）', () => {
    const { queryFn } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 10_000 });
    // 起動を probe の速さに縛らないので、同期的には unknown。
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
    // **消えると「使い切ったのか観測できないのか」を区別できない。**
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
    // codiva は取れないと分かったら恒久停止するが、alteroid では嘘になる。
    // 鍵は走行中に回せる設計なので、後から届いたら取れるようになる。
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

    // 鍵が届いた後、放っておいても取れるようになること。
    loggedIn = true;
    await expect.poll(() => poller.state().state, { timeout: 2000 }).toBe('ok');

    poller.stop();
  });

  it('取得を重ねない（遅い probe でサブプロセスを積み上げない）', async () => {
    const { queryFn, calls } = probe(() => LOGGED_IN);
    const poller = startUsagePolling({ queryFn, cwd: '/work', intervalMs: 10_000 });

    // 起動直後の1回を先に落ち着かせる（それが飛んでいる間は、こちらの3本も
    // それに合流するので、何本に畳まれたかを数えられない）。
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
