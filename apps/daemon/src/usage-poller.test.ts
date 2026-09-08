import { fetchAccountUsage } from '@alteroid/core';
import type { UsageProbeHandle, UsageProbeQuery } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { intervalForState, startUsagePolling } from './usage-poller.js';

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

/**
 * **#681 の後始末**（#684 のレビューで気づいた範囲外の事実）。
 *
 * `state === 'unavailable'` の器はすべて 30 分間隔だった。**本番はまさにその器
 * である**（`cause: 'undetermined'`）⟹ **probe の周期は5分ではなく30分だった。**
 * `.claude/skills/token-pool/SKILL.md` と `token-watch.ts` の doc が書いていた
 * 「復帰の下限は probe の周期（5分）」と食い違う。
 *
 * **ここが固定するのは1つ: 「判定できない」を「取れない」へ倒さないこと。**
 * 純粋関数で測るのは、**間隔を時計で測る歯にすると器の混み具合で揺れる**からで
 * ある（`intervalForState` を export してあるのはこのためで、無駄な間接層ではない）。
 */
describe('#681: 聞く間隔は「取れないと分かったか」で決まる', () => {
  const INTERVALS = { normal: 5 * 60_000, unavailable: 30 * 60_000 };
  const at = '2026-09-07T11:42:22.701Z';

  it('言い分けられない回は通常の間隔で聞き続ける（本番がこれである）', () => {
    // **これが直した穴そのものである。** `undetermined` は「取れないと分かった」
    // ではない —— 鍵を取り直せば取れるようになりうる。
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
    // **無いのは「その版が言えなかった」であって「取れないと分かった」ではない。**
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

  /**
   * `apiProvider` が SDK の union（8値）に無い未知の値だったとき、probe 間隔が
   * 通常（5分）のまま保たれることを、**`toAccountUsage` → `classifyLimitsUnavailable`
   * → `AccountUsageState` → `intervalForState` の実物の経路を通して**測る。
   *
   * これがこの直しの本題である——直す前は `classifyLimitsUnavailable` が未知の
   * 値を `'non_first_party'` と断定していたので、この経路は長い間隔（30分）へ
   * 落ちていた（`intervalForState` の `cause === 'non_first_party'` の分岐）。
   * **未知の値が来ると probe 間隔が 5分 → 30分 になり、枠が明けたことに気づくのが
   * 平均15分遅れる**（`intervalForState` の doc）。
   */
  it('未知の apiProvider でも probe 間隔は通常のまま（本題）', async () => {
    // 意味の無い短い文字列（前例: #704 の 'zz'）。鍵に見える値を作らない。
    const { queryFn } = probe(() => ({
      account: { apiProvider: 'zz' },
      usage: { rate_limits_available: false, rate_limits: null },
    }));
    const state = await fetchAccountUsage(queryFn, { cwd: '/work' });

    // 狙った状態まで届いていることを先に確かめる（偽陽性の緑を避ける）——
    // `apiProvider: 'zz'` が `'non_first_party'` に断定されず、`undetermined`
    // （言い分けられない）へ落ちていること。
    expect(state.state).toBe('unavailable');
    if (state.state !== 'unavailable') return;
    expect(state.cause).toBe('undetermined');

    // 本題: この状態での probe 間隔は通常（5分）である。
    expect(intervalForState(state, INTERVALS)).toBe(INTERVALS.normal);
  });
});

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

  /**
   * **配線まで測る**（純粋関数の側は上の `intervalForState` の歯が持つ）。
   *
   * 直す前は `state === 'unavailable'` の判定が**2箇所に重複**していて（起動直後と
   * 目盛りの中）、片方だけ直す形が作れた。⟹ ここは「決め方を1箇所に閉じたか」では
   * なく「**実際に短い間隔で聞き直したか**」を測る。
   */
  it('言い分けられない器でも、通常の間隔で聞き直す（30分側へ落ちない）', async () => {
    // 本番が返していた形（firstParty / プラン無し / 枠が効かない）。
    const UNDETERMINED = {
      account: { apiProvider: 'firstParty', tokenSource: 'oauth' },
      usage: { rate_limits_available: false, rate_limits: null, subscription_type: null },
    };
    let recovered = false;
    const { queryFn } = probe(() => (recovered ? LOGGED_IN : UNDETERMINED));
    const poller = startUsagePolling({
      queryFn,
      cwd: '/work',
      // **通常は短く、「取れないと分かった」側は現実的に届かない長さにする** ——
      // 30分側へ落ちたら、この歯は時間切れで落ちる。
      intervalMs: 5,
      unavailableIntervalMs: 600_000,
    });

    const first = await poller.refresh();
    expect(first.state).toBe('unavailable');
    if (first.state === 'unavailable') expect(first.cause).toBe('undetermined');

    // 鍵が取り直されて取れるようになった、を模す。
    recovered = true;
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
