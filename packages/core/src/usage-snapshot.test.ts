import { describe, expect, it } from 'vitest';

import {
  fetchAccountUsage,
  hasAccountUsageDetail,
  isNotLoggedIn,
  isSubscriptionImpossible,
  toAccountUsage,
} from './usage-snapshot.js';
import type { UsageProbeHandle, UsageProbeQuery } from './usage-probe.js';

const AT = '2026-08-14T10:00:00.000Z';

/** 実測した未ログイン環境の応答（`packages/core/scripts/usage-probe.mjs` で採った）。 */
const NOT_LOGGED_IN = {
  account: { tokenSource: 'none', apiProvider: 'firstParty' },
  usage: {
    session: { total_cost_usd: 0, model_usage: {} },
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
    behaviors: null,
  },
};

/** 実測した Claude Team の応答（docs/TECH_NOTES 相当の形）。 */
const TEAM_WITHOUT_WINDOWS = {
  account: {
    email: 'someone@example.com',
    organization: 'THE PHAGE',
    subscriptionType: 'Claude Team',
    apiProvider: 'firstParty',
  },
  usage: {
    subscription_type: 'team',
    // **`available: true` でも `null` があり得る**（Team で3回連続再現）。
    rate_limits_available: true,
    rate_limits: null,
  },
};

function probe(answers: { account?: unknown; usage?: unknown }): UsageProbeQuery {
  return () => {
    const handle: UsageProbeHandle = {
      async *[Symbol.asyncIterator]() {
        /* probe は control channel しか読まない */
      },
      accountInfo: async () => answers.account,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => answers.usage,
    };
    return handle;
  };
}

describe('/usage の応答を正規化する', () => {
  it('枠が来たら利用率とリセット時刻を読む（ISO 8601 → epoch ミリ秒）', () => {
    const usage = toAccountUsage(AT, {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.5, resets_at: '2026-08-14T15:00:00.000Z' },
        seven_day: { utilization: null, resets_at: '2026-08-20T00:00:00.000Z' },
      },
    });
    expect(usage.windows).toEqual([
      { kind: 'five_hour', utilization: 42.5, resetsAt: Date.parse('2026-08-14T15:00:00.000Z') },
      // **`utilization: null` を 0 にしない。** 0% と誤読させるのは嘘をつくのと同じ。
      {
        kind: 'seven_day',
        utilization: undefined,
        resetsAt: Date.parse('2026-08-20T00:00:00.000Z'),
      },
    ]);
  });

  it('数字が1つも無い枠は載せない（ラベルだけの行を作らない）', () => {
    const usage = toAccountUsage(AT, {
      rate_limits: { five_hour: { utilization: null, resets_at: null } },
    });
    expect(usage.windows).toEqual([]);
  });

  it('`available: true` でも `rate_limits` が null なら枠は無い', () => {
    // これを「枠がある」の根拠にしてはいけない（Team で実測）。
    const usage = toAccountUsage(AT, TEAM_WITHOUT_WINDOWS.usage, TEAM_WITHOUT_WINDOWS.account);
    expect(usage.limitsAvailable).toBe(true);
    expect(usage.windows).toEqual([]);
    // プラン名は accountInfo 側の表示用文字列を優先する。
    expect(usage.plan).toBe('Claude Team');
    expect(usage.organization).toBe('THE PHAGE');
  });

  it('支出上限（extra_usage）を読む', () => {
    const usage = toAccountUsage(AT, {
      rate_limits: {
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 42.5,
          utilization: 42.5,
          currency: 'USD',
        },
      },
    });
    expect(usage.extraUsage).toEqual({
      enabled: true,
      monthlyLimit: 100,
      usedCredits: 42.5,
      utilization: 42.5,
      currency: 'USD',
    });
  });

  it('extra_usage が無ければ undefined（＝「取れなかった」）', () => {
    // **0 で埋めない。** 「上限まで余裕がある」と「取れていない」は違う。
    expect(toAccountUsage(AT, { rate_limits: {} }).extraUsage).toBeUndefined();
    expect(toAccountUsage(AT, { rate_limits: null }).extraUsage).toBeUndefined();
  });

  it('壊れた形でも投げない（枠なしへ落ちる）', () => {
    for (const input of [null, undefined, 42, 'nonsense', { rate_limits: 'nope' }]) {
      expect(() => toAccountUsage(AT, input)).not.toThrow();
      expect(toAccountUsage(AT, input).windows).toEqual([]);
    }
  });
});

describe('「取れない」と「まだログインしていない」を混ぜない', () => {
  it('tokenSource が none なら「ログインしていない」であって「サブスクが無い」ではない', () => {
    // **ここを混ぜると、鍵が後から届く構成で永久に「サブスクなし」と表示される。**
    // alteroid は鍵を走行中に回せる設計なので、鍵が後から来るのは通常の状態である。
    const usage = toAccountUsage(AT, NOT_LOGGED_IN.usage, NOT_LOGGED_IN.account);
    expect(isNotLoggedIn(usage)).toBe(true);
    expect(isSubscriptionImpossible(usage)).toBe(false);
  });

  it('Bedrock / Vertex なら本当に取れない', () => {
    const usage = toAccountUsage(AT, {}, { apiProvider: 'bedrock' });
    expect(isSubscriptionImpossible(usage)).toBe(true);
  });

  it('プラン名が取れていれば「取れない」と決めない', () => {
    const usage = toAccountUsage(AT, TEAM_WITHOUT_WINDOWS.usage, TEAM_WITHOUT_WINDOWS.account);
    expect(isSubscriptionImpossible(usage)).toBe(false);
    expect(hasAccountUsageDetail(usage)).toBe(true);
  });
});

describe('取りに行く', () => {
  it('未ログインは failed ではなく unavailable（理由つき）', async () => {
    const state = await fetchAccountUsage(probe(NOT_LOGGED_IN), { cwd: '/work' });
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
      // ローカル開発や鍵の配布前にここへ落ちるのは正常であり、異常として扱わない。
      expect(state.reason).toContain('ログインしていない');
    }
  });

  it('枠の中身が返らなかったら「取れなかった」と言う（0% と描かない）', async () => {
    const state = await fetchAccountUsage(
      probe({ account: { apiProvider: 'firstParty' }, usage: { rate_limits_available: true } }),
      { cwd: '/work' },
    );
    expect(state.state).toBe('failed');
  });

  it('片方の口が黙っても、もう片方の答えを捨てない', async () => {
    // 実測で「accountInfo は答えるのに usage 側は答えない」が出ている。
    const state = await fetchAccountUsage(
      probe({ account: TEAM_WITHOUT_WINDOWS.account, usage: undefined }),
      { cwd: '/work' },
    );
    expect(state.state).toBe('ok');
    if (state.state === 'ok') expect(state.usage.plan).toBe('Claude Team');
  });

  it('口が丸ごと無くなっていても落ちない（SDK が改名しても止まらない）', async () => {
    const bare: UsageProbeQuery = () => ({
      async *[Symbol.asyncIterator]() {
        /* 何も来ない */
      },
    });
    const state = await fetchAccountUsage(bare, { cwd: '/work' });
    expect(state.state).toBe('failed');
  });

  it('枠が取れたら ok', async () => {
    const state = await fetchAccountUsage(
      probe({
        account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
        usage: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 12, resets_at: '2026-08-14T15:00:00.000Z' },
            extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 10 },
          },
        },
      }),
      { cwd: '/work' },
    );
    expect(state.state).toBe('ok');
    if (state.state === 'ok') {
      expect(state.usage.windows).toHaveLength(1);
      expect(state.usage.extraUsage?.monthlyLimit).toBe(50);
    }
  });
});
