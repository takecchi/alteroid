import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { ActiveAgentToken, AgentToken } from './token-pool.js';
import {
  TOKEN_TRIAL_BACKOFF_CAP_MS,
  TOKEN_TRIAL_INTERVAL_MS,
  describeTrialFailureFold,
  doubledTrialIntervalMs,
  runTokenTrial,
  selectTokenForTrial,
  type TokenTrialQuery,
} from './token-trial.js';

/**
 * ダメ元の試し（Issue #1501）。
 *
 * `selectTokenForTrial` は純粋関数なので、記録の組み合わせだけで固定できる。
 * `runTokenTrial` は SDK のメッセージ列を偽物で差し込み、判定の3値（設計点5）を
 * 固定する。
 */

const AT = Date.parse('2026-09-25T00:00:00.000Z');

function token(overrides: Partial<AgentToken> & { id: string; order: number }): AgentToken {
  return { label: overrides.id, value: `value-${overrides.id}`, ...overrides };
}

function active(tokenId: string, generation = 1): ActiveAgentToken {
  return { tokenId, generation, rotatedAt: new Date(AT).toISOString() };
}

describe('selectTokenForTrial — 試す条件（設計点1）', () => {
  it('現役がまだ一度も指名されていなければ何もしない', () => {
    const result = selectTokenForTrial({
      tokens: [token({ id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 })],
      active: null,
      at: AT,
      lastTriedAt: {},
    });
    expect(result).toBeUndefined();
  });

  it('現役が ready なら何もしない（健全な状態では費用0）', () => {
    const result = selectTokenForTrial({
      tokens: [token({ id: 'a', order: 0 })],
      active: active('a'),
      at: AT,
      lastTriedAt: {},
    });
    expect(result).toBeUndefined();
  });

  it('現役が cooling でも、ready な候補が在れば何もしない', () => {
    const result = selectTokenForTrial({
      tokens: [
        token({ id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 }),
        token({ id: 'b', order: 1 }),
      ],
      active: active('a'),
      at: AT,
      lastTriedAt: {},
    });
    expect(result).toBeUndefined();
  });

  it('disabled / invalidated の候補は「ready な候補」として数えない（対象からも外れる）', () => {
    const result = selectTokenForTrial({
      tokens: [
        token({ id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 }),
        token({ id: 'b', order: 1, disabledAt: new Date(AT).toISOString() }),
        token({ id: 'c', order: 2, invalidatedAt: new Date(AT).toISOString() }),
      ],
      active: active('a'),
      at: AT,
      lastTriedAt: {},
    });
    expect(result?.id).toBe('a');
  });

  it('現役が外された（disabled）・指名の先が消えた回も、残りが全部冷却中なら冷却中の鍵を試す', () => {
    const far = AT + 5 * 60 * 60 * 1000;
    const disabledActive = selectTokenForTrial({
      tokens: [
        token({ id: 'a', order: 0, disabledAt: new Date(AT).toISOString() }),
        token({ id: 'b', order: 1, cooldownUntil: far }),
      ],
      active: active('a'),
      at: AT,
      lastTriedAt: {},
    });
    expect(disabledActive?.id).toBe('b');
    const dangling = selectTokenForTrial({
      tokens: [token({ id: 'b', order: 1, cooldownUntil: far })],
      active: active('gone'),
      at: AT,
      lastTriedAt: {},
    });
    expect(dangling?.id).toBe('b');
  });

  it('間隔以内に時計で明けるものは対象にしない（既存の reopened に任せる）', () => {
    const result = selectTokenForTrial({
      tokens: [token({ id: 'a', order: 0, cooldownUntil: AT + TOKEN_TRIAL_INTERVAL_MS - 1 })],
      active: active('a'),
      at: AT,
      lastTriedAt: {},
    });
    expect(result).toBeUndefined();
  });

  it('間隔よりちょうど長く冷えている現役自身を選ぶ', () => {
    const result = selectTokenForTrial({
      tokens: [token({ id: 'a', order: 0, cooldownUntil: AT + TOKEN_TRIAL_INTERVAL_MS + 1 })],
      active: active('a'),
      at: AT,
      lastTriedAt: {},
    });
    expect(result?.id).toBe('a');
  });
});

describe('selectTokenForTrial — 選び方（設計点2）', () => {
  const cooling = (id: string, order: number) =>
    token({ id, order, cooldownUntil: AT + 10 * 60 * 60 * 1000 });

  it('未試行を、試した実績があるものより優先する', () => {
    const result = selectTokenForTrial({
      tokens: [cooling('a', 0), cooling('b', 1)],
      active: active('a'),
      at: AT,
      lastTriedAt: { a: AT - 1_000 },
    });
    expect(result?.id).toBe('b');
  });

  it('両方未試行なら order 昇順', () => {
    const result = selectTokenForTrial({
      tokens: [cooling('b', 1), cooling('a', 0)],
      active: active('b'),
      at: AT,
      lastTriedAt: {},
    });
    expect(result?.id).toBe('a');
  });

  it('最後に試した時刻がいちばん古いものを選ぶ', () => {
    const result = selectTokenForTrial({
      tokens: [cooling('a', 0), cooling('b', 1), cooling('c', 2)],
      active: active('a'),
      at: AT,
      lastTriedAt: {
        a: AT - TOKEN_TRIAL_INTERVAL_MS - 1_000,
        b: AT - TOKEN_TRIAL_INTERVAL_MS - 5_000,
        c: AT - TOKEN_TRIAL_INTERVAL_MS - 2_000,
      },
    });
    expect(result?.id).toBe('b');
  });

  it('まだ間隔が経っていないものは対象から外す（重ねない）', () => {
    const result = selectTokenForTrial({
      tokens: [cooling('a', 0), cooling('b', 1)],
      active: active('a'),
      at: AT,
      lastTriedAt: { a: AT - 1_000, b: AT - 1_000 },
    });
    expect(result).toBeUndefined();
  });

  it('intervalMsFor で伸びた間隔（偽陽性の退き方）を尊重する', () => {
    const doubled = TOKEN_TRIAL_INTERVAL_MS * 2;
    const result = selectTokenForTrial({
      tokens: [cooling('a', 0)],
      active: active('a'),
      at: AT,
      lastTriedAt: { a: AT - TOKEN_TRIAL_INTERVAL_MS - 1 },
      intervalMsFor: () => doubled,
    });
    expect(result).toBeUndefined();
  });
});

describe('doubledTrialIntervalMs — 偽陽性の退き方（設計点8）', () => {
  it('倍にする', () => {
    expect(doubledTrialIntervalMs(TOKEN_TRIAL_INTERVAL_MS)).toBe(TOKEN_TRIAL_INTERVAL_MS * 2);
  });

  it('上限を超えない', () => {
    expect(doubledTrialIntervalMs(TOKEN_TRIAL_BACKOFF_CAP_MS)).toBe(TOKEN_TRIAL_BACKOFF_CAP_MS);
    expect(doubledTrialIntervalMs(TOKEN_TRIAL_BACKOFF_CAP_MS * 10)).toBe(
      TOKEN_TRIAL_BACKOFF_CAP_MS,
    );
  });
});

describe('describeTrialFailureFold', () => {
  it('0件なら空文字（次に通った回の1行に何も足さない）', () => {
    expect(describeTrialFailureFold(0)).toBe('');
  });

  it('1件以上なら件数を畳んだ文言を返す', () => {
    expect(describeTrialFailureFold(3)).toContain('3');
  });
});

// ---------------------------------------------------------------------------
// runTokenTrial — 判定（設計点5）
// ---------------------------------------------------------------------------

function sdk(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function fakeQuery(messages: SDKMessage[], captured?: { options?: Options }): TokenTrialQuery {
  return (params) => {
    if (captured !== undefined) captured.options = params.options;
    return (async function* (): AsyncGenerator<SDKMessage> {
      for (const message of messages) yield message;
    })();
  };
}

function hangingQuery(): TokenTrialQuery {
  return () =>
    // eslint-disable-next-line require-yield -- 永久に解決しない（締め切りに任せる）ことがこの関数の要件そのもの
    (async function* (): AsyncGenerator<SDKMessage> {
      await new Promise<void>(() => {
        /* 永久に解決しない —— 締め切りに任せる */
      });
    })();
}

function throwingQuery(error: unknown): TokenTrialQuery {
  return () => {
    throw error;
  };
}

const SUCCESS_RESULT = sdk({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });

describe('runTokenTrial — usable', () => {
  it('応答が返り、rate_limit_event が一度も rejected を運ばなければ usable', async () => {
    const verdict = await runTokenTrial(fakeQuery([SUCCESS_RESULT]), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    expect(verdict).toEqual({ verdict: 'usable' });
  });
});

describe('runTokenTrial — unusable', () => {
  it('rate_limit_event が rejected を運んだら、result が成功でも unusable', async () => {
    const rejected = sdk({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: Math.floor(Date.parse('2026-09-26T00:00:00.000Z') / 1000),
      },
    });
    const verdict = await runTokenTrial(fakeQuery([rejected, SUCCESS_RESULT]), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    expect(verdict.verdict).toBe('unusable');
    if (verdict.verdict === 'unusable') {
      expect(verdict.retryAt).toBe(Date.parse('2026-09-26T00:00:00.000Z'));
    }
  });

  it('429 の失敗は unusable', async () => {
    const failed = sdk({
      type: 'result',
      subtype: 'error_during_execution',
      api_error_status: 429,
      result: 'rate limited',
    });
    const verdict = await runTokenTrial(fakeQuery([failed]), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    expect(verdict.verdict).toBe('unusable');
  });
});

describe('runTokenTrial — undecidable（迷ったら usable にも unusable にもしない）', () => {
  it('429 以外の result の失敗は undecidable', async () => {
    const failed = sdk({
      type: 'result',
      subtype: 'error_during_execution',
      api_error_status: 500,
      result: 'server error',
    });
    const verdict = await runTokenTrial(fakeQuery([failed]), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    expect(verdict.verdict).toBe('undecidable');
  });

  it('is_error が立った success も undecidable として扱う（#1456 の教訓）', async () => {
    const errored = sdk({ type: 'result', subtype: 'success', is_error: true, result: '枠の文言' });
    const verdict = await runTokenTrial(fakeQuery([errored]), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    expect(verdict.verdict).toBe('undecidable');
  });

  it('締め切りに間に合わなければ undecidable', async () => {
    const verdict = await runTokenTrial(hangingQuery(), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
      timeoutMs: 5,
    });
    expect(verdict.verdict).toBe('undecidable');
  });

  it('queryFn が投げても undecidable（投げない契約）', async () => {
    const verdict = await runTokenTrial(throwingQuery(new Error('boom')), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    expect(verdict.verdict).toBe('undecidable');
  });

  it('1件もメッセージが届かなければ undecidable', async () => {
    const verdict = await runTokenTrial(fakeQuery([]), {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    expect(verdict.verdict).toBe('undecidable');
  });
});

describe('runTokenTrial — 層に撒かない・道具を持たない', () => {
  it('道具無し・maxTurns 1・settingSources 空で、渡した鍵とモデルを使う', async () => {
    const captured: { options?: Options } = {};
    await runTokenTrial(fakeQuery([SUCCESS_RESULT], captured), {
      cwd: '/tmp/cwd',
      token: 'secret-token-value',
      model: 'fable',
      withheldEnvKeys: ['SOME_OTHER_KEY'],
    });
    expect(captured.options?.tools).toEqual([]);
    expect(captured.options?.maxTurns).toBe(1);
    expect(captured.options?.settingSources).toEqual([]);
    expect(captured.options?.model).toBe('fable');
    expect(captured.options?.cwd).toBe('/tmp/cwd');
    const env = captured.options?.env as NodeJS.ProcessEnv | undefined;
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('secret-token-value');
    expect('SOME_OTHER_KEY' in (env ?? {})).toBe(false);
  });

  it('送るプロンプトは1つだけ（1回の試しで終わる）', async () => {
    let count = 0;
    const countingQuery: TokenTrialQuery = ({ prompt }) => {
      void (async () => {
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        for (;;) {
          const step = await iterator.next();
          if (step.done === true) break;
          count += 1;
        }
      })();
      return (async function* (): AsyncGenerator<SDKMessage> {
        yield SUCCESS_RESULT;
      })();
    };
    await runTokenTrial(countingQuery, {
      cwd: '/tmp',
      token: 'secret-token',
      model: 'fable',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(count).toBe(1);
  });
});
