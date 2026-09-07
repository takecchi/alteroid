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

/** `queryFn` に渡された `options`（SDK の `Options`）を横から覗くための偽物。 */
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

/**
 * **現役のトークンで測る**（人間の決定 2026-09-07）。
 *
 * ここが無かったあいだ、probe は `process.env` をそのまま継承していた ⟹
 * **回した後は「降りたトークンのアカウント」を測り続け、`GET /usage` の `account`
 * とクローンが見る `accountUsage` は降りた鍵の枠を報告していた。**
 */
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
    // **空の `env` を渡すと `fetchAccountUsage` が `env` を組み立ててしまう。**
    // 既定の構成（プールが空 ＝ 箱も空）の挙動が、それだけで変わりうる。
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
    // **回すのは走行中である。** 凍らせると、回した鍵が永久に届かない。
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
    // **回し手へ渡すのは「この回に取れたもの」である。** `state()` は「取れな
    // かったことで取れていた値を捨てない」ために古い `ok` を保つので、そちらを
    // 渡すと**同じ観測を何度も新しい観測として渡す**ことになる。
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

    // 切り離して呼ぶので、1 tick 待つ。
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual(['ok', 'failed']);
    // 覚えているほうは `ok` のまま（既存の約束）。
    expect(poller.state().state).toBe('ok');
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
