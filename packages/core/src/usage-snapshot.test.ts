import type { ApiKeySource } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { judgeTokenCandidate } from './token-candidate.js';
import {
  accountApiKeySourceSchema,
  accountInfoKeysOf,
  accountUsageSchema,
  accountUsageStateSchema,
  classifyLimitsUnavailable,
  describeLimitsUnavailable,
  describeOuterFailure,
  describeSilentChannels,
  fetchAccountUsage,
  hasAccountUsageDetail,
  isNotLoggedIn,
  toAccountApiKeySource,
  toAccountApiProvider,
  toAccountUsage,
  toTokenSourcePresence,
} from './usage-snapshot.js';
import type { UsageProbeHandle, UsageProbeQuery } from './usage-probe.js';
import type { AccountApiKeySource } from './usage-snapshot.js';

const AT = '2026-08-14T10:00:00.000Z';

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

const TEAM_WITHOUT_WINDOWS = {
  account: {
    email: 'someone@example.com',
    organization: 'THE PHAGE',
    subscriptionType: 'Claude Team',
    apiProvider: 'firstParty',
  },
  usage: {
    subscription_type: 'team',
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
    const usage = toAccountUsage(AT, TEAM_WITHOUT_WINDOWS.usage, TEAM_WITHOUT_WINDOWS.account);
    expect(usage.limitsAvailable).toBe(true);
    expect(usage.windows).toEqual([]);
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

describe('plan / organization の「欄が無い」と「空」を畳まない', () => {
  it('organization が無ければ undefined（＝欄が無い）', () => {
    const usage = toAccountUsage(AT, {}, {});
    expect(usage.organization).toBeUndefined();
  });

  it("organization: '' は '' のまま（undefined に畳まない）", () => {
    const usage = toAccountUsage(AT, {}, { organization: '' });
    expect(usage.organization).toBe('');
  });

  it('organization が空白のみでも、値は加工せずそのまま運ぶ', () => {
    const usage = toAccountUsage(AT, {}, { organization: '   ' });
    expect(usage.organization).toBe('   ');
  });

  it('subscriptionType も subscription_type も無ければ plan は undefined', () => {
    const usage = toAccountUsage(AT, {}, {});
    expect(usage.plan).toBeUndefined();
  });

  it("subscriptionType: '' かつ subscription_type 無しなら plan は ''", () => {
    const usage = toAccountUsage(AT, {}, { subscriptionType: '' });
    expect(usage.plan).toBe('');
  });

  it("subscriptionType 無し かつ subscription_type: '' なら plan は ''", () => {
    const usage = toAccountUsage(AT, { subscription_type: '' }, {});
    expect(usage.plan).toBe('');
  });

  it("両方の出所が '' でも plan は ''（undefined へ畳まない）", () => {
    const usage = toAccountUsage(AT, { subscription_type: '' }, { subscriptionType: '' });
    expect(usage.plan).toBe('');
  });

  it('空の第1候補は非空の第2候補を隠さない（優先順位はあっても、空が勝たない）', () => {
    const usage = toAccountUsage(AT, { subscription_type: 'zz' }, { subscriptionType: '' });
    expect(usage.plan).toBe('zz');
  });

  it('両方とも非空なら、優先順位（account 側が先）は変えていない', () => {
    const usage = toAccountUsage(AT, { subscription_type: 'yy' }, { subscriptionType: 'zz' });
    expect(usage.plan).toBe('zz');
  });

  it('判定の保存: limitsAvailable: false かつ plan: "" でも classifyLimitsUnavailable は undetermined のまま', () => {
    const usage = toAccountUsage(AT, { rate_limits_available: false }, { subscriptionType: '' });
    expect(usage.plan).toBe('');
    expect(classifyLimitsUnavailable(usage, undefined)).toBe('undetermined');
  });

  it('判定の保存: plan: "" ・枠なし・extraUsage なしで hasAccountUsageDetail は false のまま', () => {
    const usage = toAccountUsage(AT, {}, { subscriptionType: '' });
    expect(usage.plan).toBe('');
    expect(usage.windows).toEqual([]);
    expect(usage.extraUsage).toBeUndefined();
    expect(hasAccountUsageDetail(usage)).toBe(false);
  });

  it('理由文（GET /usage に載る reason）も plan の3状態を畳まない', () => {
    const absent = toAccountUsage(AT, { rate_limits_available: false }, {});
    const empty = toAccountUsage(AT, { rate_limits_available: false }, { subscriptionType: '' });
    expect(absent.plan).toBeUndefined();
    expect(empty.plan).toBe('');
    const reasons = [absent, empty].map((usage) =>
      describeLimitsUnavailable(usage, 'undetermined'),
    );
    expect(reasons[0]).toContain('plan: 不明）');
    expect(reasons[1]).toContain('plan: 不明（欄はあるが空）');
    expect(new Set(reasons).size).toBe(2);
  });
});

describe('「取れない」と「まだログインしていない」を混ぜない', () => {
  it('tokenSource が none なら「ログインしていない」であって「サブスクが無い」ではない', () => {
    const usage = toAccountUsage(AT, NOT_LOGGED_IN.usage, NOT_LOGGED_IN.account);
    expect(isNotLoggedIn(NOT_LOGGED_IN.account.tokenSource)).toBe(true);
    expect(classifyLimitsUnavailable(usage, NOT_LOGGED_IN.account.tokenSource)).toBe(
      'not_logged_in',
    );
  });

  it('Bedrock / Vertex なら本当に取れない', () => {
    const usage = toAccountUsage(AT, {}, { apiProvider: 'bedrock' });
    expect(classifyLimitsUnavailable(usage, undefined)).toBe('non_first_party');
  });

  it('知らない apiProvider（unrecognized）を non_first_party に断定しない', () => {
    const usage = toAccountUsage(AT, {}, { apiProvider: 'zz' });
    expect(usage.apiProvider).toBe('unrecognized');
    expect(classifyLimitsUnavailable(usage, undefined)).not.toBe('non_first_party');
  });

  it('プラン名が取れていれば「取れない」と決めない', () => {
    const usage = toAccountUsage(AT, TEAM_WITHOUT_WINDOWS.usage, TEAM_WITHOUT_WINDOWS.account);
    expect(classifyLimitsUnavailable(usage, undefined)).toBeUndefined();
    expect(hasAccountUsageDetail(usage)).toBe(true);
  });
});

describe('枠が効かない理由を言い分ける（#681）', () => {
  const FIRST_PARTY_NO_LIMITS = {
    account: { apiProvider: 'firstParty', tokenSource: 'oauth' },
    usage: { rate_limits_available: false, rate_limits: null, subscription_type: null },
  };

  it('firstParty で枠が効かないとき「サブスクが無い」と断定しない', () => {
    const usage = toAccountUsage(AT, FIRST_PARTY_NO_LIMITS.usage, FIRST_PARTY_NO_LIMITS.account);
    expect(classifyLimitsUnavailable(usage, FIRST_PARTY_NO_LIMITS.account.tokenSource)).toBe(
      'undetermined',
    );
  });

  it('文言に「サブスクが無い」と読める言い方を残さない', () => {
    const usage = toAccountUsage(AT, FIRST_PARTY_NO_LIMITS.usage, FIRST_PARTY_NO_LIMITS.account);
    const reason = describeLimitsUnavailable(usage, 'undetermined');
    expect(reason).not.toContain('枠が無い');
    expect(reason).toContain('言い分けられない');
    expect(reason).toContain('rate_limits_available: false');
    expect(reason).toContain('apiProvider: firstParty');
  });

  it('3P バックエンドの文言は断定してよい（こちらは消去法ではない）', () => {
    const usage = toAccountUsage(AT, {}, { apiProvider: 'vertex' });
    expect(describeLimitsUnavailable(usage, 'non_first_party')).toContain('apiProvider: vertex');
  });

  it('apiProvider を名乗っていない回を non_first_party へ倒さない', () => {
    const usage = toAccountUsage(AT, { rate_limits_available: false }, {});
    expect(classifyLimitsUnavailable(usage, undefined)).toBe('undetermined');
  });

  it('unavailable の状態に理由の欄が付く（判定は undecidable のまま）', async () => {
    const state = await fetchAccountUsage(probe(FIRST_PARTY_NO_LIMITS), { cwd: '/work' });
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
      expect(state.cause).toBe('undetermined');
      expect(state.reason).toContain('言い分けられない');
      expect(state.accountKeys).toEqual(['apiProvider', 'tokenSource']);
      expect(state.accountKeys).not.toContain('apiKeySource');
    }
  });

  it('accountKeys は名前だけを運び、値は1文字も運ばない（#1458）', async () => {
    const state = await fetchAccountUsage(
      probe({
        account: { apiProvider: 'firstParty', apiKeySource: 'sk-ant-secret-value' },
        usage: FIRST_PARTY_NO_LIMITS.usage,
      }),
      { cwd: '/work' },
    );
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
      expect(state.accountKeys).toEqual(['apiKeySource', 'apiProvider']);
      expect(JSON.stringify(state)).not.toContain('sk-ant-secret-value');
    }
  });
});

describe('accountInfoKeysOf（#1458）', () => {
  it('物でなければ undefined（応答が無かった）、空の物なら []', () => {
    expect(accountInfoKeysOf(undefined)).toBeUndefined();
    expect(accountInfoKeysOf(null)).toBeUndefined();
    expect(accountInfoKeysOf('x')).toBeUndefined();
    expect(accountInfoKeysOf([])).toBeUndefined();
    expect(accountInfoKeysOf({})).toEqual([]);
  });

  it('識別子の形の名前だけを昇順で返す（自由文の名前は運ばない）', () => {
    expect(accountInfoKeysOf({ zeta: 1, alpha: 2, 'has space': 3, '': 4 })).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('上限を超えた名前は切る', () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]),
    );
    expect(accountInfoKeysOf(many)).toHaveLength(32);
  });
});

describe('取りに行く', () => {
  it('未ログインは failed ではなく unavailable（理由つき）', async () => {
    const state = await fetchAccountUsage(probe(NOT_LOGGED_IN), { cwd: '/work' });
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
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

describe('#429: 失敗の理由を構造化して持ち帰る（固定文言に畳まない）', () => {
  it('probe の起動が例外で終わったら、理由をそのまま reason へ持ち帰る', async () => {
    const throwing: UsageProbeQuery = () => {
      throw new Error('spawn ENOENT: no such file');
    };
    const state = await fetchAccountUsage(throwing, { cwd: '/work' });
    expect(state.state).toBe('failed');
    if (state.state === 'failed') {
      expect(state.reason).toContain('起動失敗');
      expect(state.reason).toContain('spawn ENOENT: no such file');
    }
  });

  it('accountInfo が reject したら、その理由を「2つの口」の内訳に載せる（usage 側は無音だと分かる）', async () => {
    const rejecting: UsageProbeQuery = () => {
      const handle: UsageProbeHandle = {
        async *[Symbol.asyncIterator]() {
          /* probe は control channel しか読まない */
        },
        accountInfo: () => Promise.reject(new Error('authentication failed')),
      };
      return handle;
    };
    const state = await fetchAccountUsage(rejecting, { cwd: '/work' });
    expect(state.state).toBe('failed');
    if (state.state === 'failed') {
      expect(state.reason).toContain('2つの口のどちらも答えなかった');
      expect(state.reason).toContain('accountInfo: 例外: Error: authentication failed');
      expect(state.reason).toContain('usage: 応答なし');
    }
  });

  it('#429 秘密の扱い: reject の理由に候補トークンの値が入っていても reason からは伏せる', async () => {
    const secretToken = 'sk-ant-DUMMY-NOT-A-REAL-TOKEN-9876543210';
    const rejecting: UsageProbeQuery = () => {
      const handle: UsageProbeHandle = {
        async *[Symbol.asyncIterator]() {
          /* probe は control channel しか読まない */
        },
        accountInfo: () => Promise.reject(new Error(`rejected token ${secretToken}`)),
      };
      return handle;
    };
    const state = await fetchAccountUsage(rejecting, {
      cwd: '/work',
      env: { CLAUDE_CODE_OAUTH_TOKEN: secretToken },
    });
    expect(state.state).toBe('failed');
    if (state.state === 'failed') {
      expect(state.reason).not.toContain(secretToken);
      expect(state.reason).toContain('[REDACTED]');
    }
  });

  it('⭐ reason が詳しくなっても、判定（judgeTokenCandidate）の結果は1つも変わらない', async () => {
    const throwing: UsageProbeQuery = () => {
      throw new Error('spawn ENOENT: no such file');
    };
    const state = await fetchAccountUsage(throwing, { cwd: '/work' });
    expect(judgeTokenCandidate(state)).toEqual({
      verdict: 'undecidable',
      reason: expect.stringContaining('probe が失敗した'),
    });
  });
});

describe('describeOuterFailure（#429・単体）', () => {
  it('exception ＝ 起動失敗', () => {
    expect(describeOuterFailure({ kind: 'exception', reason: 'Error: boom' })).toBe(
      'probe が応答しなかった（起動失敗: Error: boom）',
    );
  });

  it('timeout ＝ 締め切り', () => {
    expect(
      describeOuterFailure({ kind: 'timeout', reason: '締め切り（20ms）に間に合わなかった' }),
    ).toBe('probe が応答しなかった（締め切り: 締め切り（20ms）に間に合わなかった）');
  });

  it('aborted ＝ 中断', () => {
    expect(describeOuterFailure({ kind: 'aborted', reason: '観測中に中断された' })).toBe(
      'probe が応答しなかった（中断: 観測中に中断された）',
    );
  });
});

describe('describeSilentChannels（#429・単体）', () => {
  it('両方とも無音（口が無いか締め切り）', () => {
    expect(describeSilentChannels(undefined, undefined)).toBe(
      '2つの口のどちらも答えなかった' +
        '（accountInfo: 応答なし（口が無いか、締め切りに間に合わなかった） / ' +
        'usage: 応答なし（口が無いか、締め切りに間に合わなかった））',
    );
  });

  it('片方だけ例外', () => {
    expect(describeSilentChannels('Error: auth failed', undefined)).toBe(
      '2つの口のどちらも答えなかった' +
        '（accountInfo: 例外: Error: auth failed / ' +
        'usage: 応答なし（口が無いか、締め切りに間に合わなかった））',
    );
  });

  it('両方とも例外', () => {
    expect(describeSilentChannels('Error: a', 'Error: b')).toBe(
      '2つの口のどちらも答えなかった（accountInfo: 例外: Error: a / usage: 例外: Error: b）',
    );
  });
});

describe('toAccountApiKeySource（#681 (2)・単体）', () => {
  it('文字列でない、または空文字は undefined（「取れなかった」）', () => {
    for (const raw of [undefined, null, 42, {}, [], '', '   ']) {
      expect(toAccountApiKeySource(raw)).toBeUndefined();
    }
  });

  it('SDK の9値はそのまま通す', () => {
    const known = [
      'ANTHROPIC_API_KEY',
      'apiKeyHelper',
      '/login managed key',
      'none',
      'user',
      'project',
      'org',
      'temporary',
      'oauth',
    ];
    for (const value of known) {
      expect(toAccountApiKeySource(value)).toBe(value);
    }
  });

  it('知らない非空文字列は unrecognized に落ち、元の文字は1文字も残らない', () => {
    const secret = 'sk-ant-xxxxxxxx';
    const result = toAccountApiKeySource(secret);
    expect(result).toBe('unrecognized');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('欄が無い（undefined）と知らない値（unrecognized）は区別できる', () => {
    expect(toAccountApiKeySource(undefined)).not.toBe(toAccountApiKeySource('sk-ant-xxxxxxxx'));
    expect(toAccountApiKeySource(undefined)).toBeUndefined();
    expect(toAccountApiKeySource('sk-ant-xxxxxxxx')).toBe('unrecognized');
  });
});

type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('SDK の ApiKeySource と許可リストの同期（#1447）', () => {
  it('SDK の ApiKeySource と、unrecognized を除いた AccountApiKeySource は同じ値の集合である', () => {
    const same: SameUnion<ApiKeySource, Exclude<AccountApiKeySource, 'unrecognized'>> = true;
    expect(same).toBe(true);
  });

  it('zod enum の unrecognized 以外の値は、全部 toAccountApiKeySource を素通りする', () => {
    const options = accountApiKeySourceSchema.options.filter((value) => value !== 'unrecognized');
    expect(options).toHaveLength(9);
    for (const value of options) {
      expect(toAccountApiKeySource(value)).toBe(value);
    }
  });
});

describe('toAccountApiProvider（apiProvider 許可リスト・単体）', () => {
  it('文字列でない、または空文字・空白のみは undefined（「名乗っていない」）', () => {
    for (const raw of [undefined, null, 42, {}, [], '', '   ']) {
      expect(toAccountApiProvider(raw)).toBeUndefined();
    }
  });

  it('SDK の8値はそのまま通す', () => {
    const known = [
      'firstParty',
      'bedrock',
      'vertex',
      'foundry',
      'anthropicAws',
      'anthropicGoogleCloud',
      'mantle',
      'gateway',
    ];
    for (const value of known) {
      expect(toAccountApiProvider(value)).toBe(value);
    }
  });

  it('知らない非空文字列は unrecognized に落ち、元の文字は1文字も残らない', () => {
    const marker = 'zz';
    const result = toAccountApiProvider(marker);
    expect(result).toBe('unrecognized');
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('名乗っていない（undefined）と知らない値（unrecognized）は区別できる', () => {
    expect(toAccountApiProvider(undefined)).not.toBe(toAccountApiProvider('zz'));
    expect(toAccountApiProvider(undefined)).toBeUndefined();
    expect(toAccountApiProvider('zz')).toBe('unrecognized');
  });
});

describe('toTokenSourcePresence（#706・単体）', () => {
  it('文字列でない（欄そのものが無い場合を含む）は not_returned', () => {
    for (const raw of [undefined, null, 42, {}, []]) {
      expect(toTokenSourcePresence(raw)).toBe('not_returned');
    }
  });

  it('空文字・空白のみは empty（not_returned とは別の値）', () => {
    for (const raw of ['', '   ', '\t\n']) {
      expect(toTokenSourcePresence(raw)).toBe('empty');
    }
    expect(toTokenSourcePresence('')).not.toBe(toTokenSourcePresence(undefined));
  });

  it('非空文字列は present（値そのものは返り値に出ない）', () => {
    const marker = 'zz';
    const result = toTokenSourcePresence(marker);
    expect(result).toBe('present');
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('3値は互いに別の値である（undefined を含めて4通りが全部区別できる）', () => {
    const values = new Set([
      toTokenSourcePresence(undefined),
      toTokenSourcePresence(''),
      toTokenSourcePresence('zz'),
    ]);
    expect(values.size).toBe(3);
    expect(values).toEqual(new Set(['not_returned', 'empty', 'present']));
  });
});

describe('AccountUsage.tokenSourcePresence（#706）', () => {
  it('欄が無ければ not_returned（既定値で埋めない）', () => {
    const usage = toAccountUsage(AT, {}, {});
    expect(usage.tokenSourcePresence).toBe('not_returned');
    expect(() => accountUsageSchema.parse(usage)).not.toThrow();
  });

  it('空文字なら empty', () => {
    const usage = toAccountUsage(AT, {}, { tokenSource: '   ' });
    expect(usage.tokenSourcePresence).toBe('empty');
  });

  it('非空文字列なら present。生の文字列は1文字も AccountUsage に残らない', () => {
    const marker = 'zz';
    const usage = toAccountUsage(AT, {}, { tokenSource: marker });
    expect(usage.tokenSourcePresence).toBe('present');
    expect(JSON.stringify(usage)).not.toContain(marker);
    expect(usage).not.toHaveProperty('tokenSource');
  });

  it('classifyLimitsUnavailable は tokenSourcePresence を読まない（判定は別引数の生値で行う）', () => {
    const usageJson = { rate_limits_available: false, rate_limits: null, subscription_type: null };
    const withPresent = toAccountUsage(AT, usageJson, {
      apiProvider: 'firstParty',
      tokenSource: 'zz',
    });
    const withEmpty = toAccountUsage(AT, usageJson, { apiProvider: 'firstParty', tokenSource: '' });
    const withoutField = toAccountUsage(AT, usageJson, { apiProvider: 'firstParty' });

    expect(withPresent.tokenSourcePresence).toBe('present');
    expect(withEmpty.tokenSourcePresence).toBe('empty');
    expect(withoutField.tokenSourcePresence).toBe('not_returned');

    expect(classifyLimitsUnavailable(withPresent, 'zz')).toBe('undetermined');
    expect(classifyLimitsUnavailable(withEmpty, '')).toBe('undetermined');
    expect(classifyLimitsUnavailable(withoutField, undefined)).toBe('undetermined');
  });
});

describe('accountUsageSchema: tokenSourcePresence の版ずれ（欄が無い）', () => {
  it('tokenSourcePresence を持たない応答も引き続き通る（旧い daemon）', () => {
    const legacy = {
      at: AT,
      limitsAvailable: false,
      windows: [],
    };
    expect(() => accountUsageSchema.parse(legacy)).not.toThrow();
    expect(accountUsageSchema.parse(legacy).tokenSourcePresence).toBeUndefined();
  });

  it('toAccountUsage を通す限り、tokenSourcePresence は必ず3値のどれかになる（省略されない）', () => {
    const usage = toAccountUsage(AT, {}, {});
    expect(usage.tokenSourcePresence).not.toBeUndefined();
    expect(['not_returned', 'present', 'empty']).toContain(usage.tokenSourcePresence);
  });
});

describe('AccountUsage.apiKeySource（#681 (2)）', () => {
  it('apiKeySource: none が AccountUsage に載り、GET /usage の形（accountUsageSchema）を通る', () => {
    const usage = toAccountUsage(AT, {}, { apiKeySource: 'none' });
    expect(usage.apiKeySource).toBe('none');
    expect(() => accountUsageSchema.parse(usage)).not.toThrow();
  });

  it('欄が無ければ undefined のまま（既定値で埋めない）', () => {
    const usage = toAccountUsage(AT, {}, {});
    expect(usage.apiKeySource).toBeUndefined();
    expect(() => accountUsageSchema.parse(usage)).not.toThrow();
  });

  it('知らない自由文字列（鍵に見える文字列）は unrecognized に落ち、元の文字は1文字も残らない', () => {
    const secret = 'sk-ant-xxxxxxxx';
    const usage = toAccountUsage(AT, {}, { apiKeySource: secret });
    expect(usage.apiKeySource).toBe('unrecognized');
    expect(JSON.stringify(usage)).not.toContain(secret);
  });

  it('classifyLimitsUnavailable の結果は apiKeySource の有無・値で変わらない', () => {
    const usageJson = { rate_limits_available: false, rate_limits: null, subscription_type: null };
    const accountBase = { apiProvider: 'firstParty', tokenSource: 'oauth' };

    const withoutField = toAccountUsage(AT, usageJson, accountBase);
    const withNone = toAccountUsage(AT, usageJson, { ...accountBase, apiKeySource: 'none' });
    const withOauth = toAccountUsage(AT, usageJson, { ...accountBase, apiKeySource: 'oauth' });
    const withUnrecognized = toAccountUsage(AT, usageJson, {
      ...accountBase,
      apiKeySource: 'sk-ant-xxxxxxxx',
    });

    const causeWithoutField = classifyLimitsUnavailable(withoutField, accountBase.tokenSource);
    expect(causeWithoutField).toBe('undetermined');
    expect(classifyLimitsUnavailable(withNone, accountBase.tokenSource)).toBe(causeWithoutField);
    expect(classifyLimitsUnavailable(withOauth, accountBase.tokenSource)).toBe(causeWithoutField);
    expect(classifyLimitsUnavailable(withUnrecognized, accountBase.tokenSource)).toBe(
      causeWithoutField,
    );
  });
});

describe('accountUsageStateSchema: unavailable 枝の apiKeySource', () => {
  it('apiKeySource が在る unavailable を通す', () => {
    const state = {
      state: 'unavailable' as const,
      at: AT,
      reason: 'テスト用の理由',
      cause: 'undetermined' as const,
      apiKeySource: 'none' as const,
    };
    expect(() => accountUsageStateSchema.parse(state)).not.toThrow();
    expect(accountUsageStateSchema.parse(state).state).toBe('unavailable');
  });

  it('apiKeySource が無い unavailable も通る', () => {
    const state = {
      state: 'unavailable' as const,
      at: AT,
      reason: 'テスト用の理由',
      cause: 'undetermined' as const,
    };
    expect(() => accountUsageStateSchema.parse(state)).not.toThrow();
  });
});

describe('fetchAccountUsage: undetermined でも apiKeySource が運ばれる（#681 の続き）', () => {
  it('unrecognized な apiKeySource（zz）が unavailable の状態まで運ばれる', async () => {
    const state = await fetchAccountUsage(
      probe({
        account: { apiProvider: 'firstParty', tokenSource: 'oauth', apiKeySource: 'zz' },
        usage: { rate_limits_available: false, rate_limits: null, subscription_type: null },
      }),
      { cwd: '/work' },
    );
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
      expect(state.cause).toBe('undetermined');
      expect(state.apiKeySource).toBe('unrecognized');
    }
  });

  it('none な apiKeySource がそのまま unavailable の状態まで運ばれる', async () => {
    const state = await fetchAccountUsage(
      probe({
        account: { apiProvider: 'firstParty', tokenSource: 'oauth', apiKeySource: 'none' },
        usage: { rate_limits_available: false, rate_limits: null, subscription_type: null },
      }),
      { cwd: '/work' },
    );
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
      expect(state.apiKeySource).toBe('none');
    }
  });

  it('apiKeySource が欄ごと無いときは undefined のまま運ばれる（既定値で埋めない）', async () => {
    const state = await fetchAccountUsage(
      probe({
        account: { apiProvider: 'firstParty', tokenSource: 'oauth' },
        usage: { rate_limits_available: false, rate_limits: null, subscription_type: null },
      }),
      { cwd: '/work' },
    );
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
      expect(state.apiKeySource).toBeUndefined();
    }
  });
});
