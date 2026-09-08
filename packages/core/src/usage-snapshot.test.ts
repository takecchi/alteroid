import { describe, expect, it } from 'vitest';

import { judgeTokenCandidate } from './token-candidate.js';
import {
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
    // **保証は弱めていない。** かつては「`isSubscriptionImpossible` が偽」で
    // 測っていた（＝「サブスクが無いとは言わない」）。いまは**どの理由を名乗るか**
    // まで測るので、`non_first_party` / `undetermined` へ倒れたら落ちる（#681）。
    expect(classifyLimitsUnavailable(usage)).toBe('not_logged_in');
  });

  it('Bedrock / Vertex なら本当に取れない', () => {
    const usage = toAccountUsage(AT, {}, { apiProvider: 'bedrock' });
    expect(classifyLimitsUnavailable(usage)).toBe('non_first_party');
  });

  it('プラン名が取れていれば「取れない」と決めない', () => {
    const usage = toAccountUsage(AT, TEAM_WITHOUT_WINDOWS.usage, TEAM_WITHOUT_WINDOWS.account);
    expect(classifyLimitsUnavailable(usage)).toBeUndefined();
    expect(hasAccountUsageDetail(usage)).toBe(true);
  });
});

describe('枠が効かない理由を言い分ける（#681）', () => {
  /**
   * 本番（Railway、2026-09-07）が返していた形。**`apiProvider` は `firstParty` を
   * 名乗り、プランは取れず、`rate_limits_available` が false** ——
   * この組み合わせが「サブスクが無い」に化けていた。
   */
  const FIRST_PARTY_NO_LIMITS = {
    account: { apiProvider: 'firstParty', tokenSource: 'oauth' },
    usage: { rate_limits_available: false, rate_limits: null, subscription_type: null },
  };

  it('firstParty で枠が効かないとき「サブスクが無い」と断定しない', () => {
    const usage = toAccountUsage(AT, FIRST_PARTY_NO_LIMITS.usage, FIRST_PARTY_NO_LIMITS.account);
    expect(classifyLimitsUnavailable(usage)).toBe('undetermined');
  });

  it('文言に「サブスクが無い」と読める言い方を残さない', () => {
    const usage = toAccountUsage(AT, FIRST_PARTY_NO_LIMITS.usage, FIRST_PARTY_NO_LIMITS.account);
    const reason = describeLimitsUnavailable(usage, 'undetermined');
    // **これが直した嘘そのものである。** 読んだ人間が「このアカウントは Claude の
    // サブスクを持っていない」と読み、実際に読み違えた（#678 の調査 → #681）。
    expect(reason).not.toContain('枠が無い');
    expect(reason).toContain('言い分けられない');
    // 判定の材料を人間が突き合わせられる形で出す（観測できた3つ）。
    expect(reason).toContain('rate_limits_available: false');
    expect(reason).toContain('apiProvider: firstParty');
  });

  it('3P バックエンドの文言は断定してよい（こちらは消去法ではない）', () => {
    const usage = toAccountUsage(AT, {}, { apiProvider: 'vertex' });
    expect(describeLimitsUnavailable(usage, 'non_first_party')).toContain('apiProvider: vertex');
  });

  it('apiProvider を名乗っていない回を non_first_party へ倒さない', () => {
    // **観測していないことを断定しない。** `accountInfo` の口が答えなかった回も
    // ここへ来る（`describeSilentChannels` の doc の (1) / (2)）。
    const usage = toAccountUsage(AT, { rate_limits_available: false }, {});
    expect(classifyLimitsUnavailable(usage)).toBe('undetermined');
  });

  it('unavailable の状態に理由の欄が付く（判定は undecidable のまま）', async () => {
    const state = await fetchAccountUsage(probe(FIRST_PARTY_NO_LIMITS), { cwd: '/work' });
    expect(state.state).toBe('unavailable');
    if (state.state === 'unavailable') {
      expect(state.cause).toBe('undetermined');
      expect(state.reason).toContain('言い分けられない');
    }
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
        // usage 側の口はそもそも無い（SDK が改名したのと同じ状況）。
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
    // 以前の固定文言（'probe が応答しなかった（起動失敗・締め切り・中断）'）で
    // 判定していたのと同じ verdict が、詳しくなった reason でも出ることを確かめる。
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
    // 逐語（ApiKeySource の doc）は `AccountApiKeySource` の doc コメントが持つ。
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
    // 鍵に見える文字列を通しても、返り値には1文字も現れないことが安全側の歯である。
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
    // これが安全側の歯である。`AccountUsage` は `GET /usage` にそのまま載り、
    // `GET /usage` はアクセストークンで読める面なので、鍵に関する自由文字列が
    // そのまま外へ配られてはならない。
    const secret = 'sk-ant-xxxxxxxx';
    const usage = toAccountUsage(AT, {}, { apiKeySource: secret });
    expect(usage.apiKeySource).toBe('unrecognized');
    expect(JSON.stringify(usage)).not.toContain(secret);
  });

  /**
   * ⭐ 分岐させていないことの歯（#681 (2) の核心）。
   *
   * `classifyLimitsUnavailable` は `apiKeySource` を読んではいけない——観測を
   * 1本増やすだけで判定は増やさない、という仕様そのものを撃つ。同じ
   * `usage`/`account` の他の欄を固定したまま `apiKeySource` だけを
   * 変えても（無い／既知の値／unrecognized）、判定結果が1ミリも変わらないことを
   * 確かめる。
   */
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

    const causeWithoutField = classifyLimitsUnavailable(withoutField);
    expect(causeWithoutField).toBe('undetermined');
    expect(classifyLimitsUnavailable(withNone)).toBe(causeWithoutField);
    expect(classifyLimitsUnavailable(withOauth)).toBe(causeWithoutField);
    expect(classifyLimitsUnavailable(withUnrecognized)).toBe(causeWithoutField);
  });
});

/**
 * `accountUsageStateSchema` の `unavailable` 枝が持つ `apiKeySource`（#681 の続き）。
 *
 * これが無いと、`unavailable` の状態が `apiKeySource` を運んでも `GET /usage` の
 * 応答スキーマが弾く（または黙って消す）ことになる。
 */
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

  /**
   * **`.optional()` の版ずれの保証。** `apiKeySource` を持たない unavailable
   * （旧い版のデーモンが返す応答、または SDK がこの欄を返さなかった回）も
   * 引き続き通ること——必須にすると、その組み合わせで `GET /usage` の応答が
   * まるごと parse に失敗する。
   */
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

/**
 * ⭐ `fetchAccountUsage` を通して、`undetermined` に落ちたときも `apiKeySource`
 * が運ばれることを測る歯（#681 の続き）。
 *
 * この歯が実物の経路を通っていることは、変異試験(b)（`fetchAccountUsage` が
 * `apiKeySource: usage.apiKeySource,` を運ぶ1行を消す）が赤くなることで示す
 * ——足場（`probe()`）が固定値を返しているだけなら、この歯は緑のまま動かない。
 */
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
      // 意味の無い短い文字列（'zz'）は許可リスト（toAccountApiKeySource）を通って
      // 'unrecognized' に畳まれる。生の 'zz' が1文字も残らないことも確かめる。
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
