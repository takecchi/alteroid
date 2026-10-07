import { describe, expect, it } from 'vitest';

import {
  createMemoryStores,
  fingerprintOf,
  createTokenRotator,
  type RunnerClient,
  type RunnerRegistry,
} from '@alteroid/core';

import {
  createAgentTokenHolder,
  createRunnerTokenSync,
  createTokenSpread,
} from './token-spread.js';

const SECRET = 'sk-ant-oat-do-not-leak';

function fakeClient(
  runnerId: string,
  behavior: 'ok' | 'throw' = 'ok',
): RunnerClient & { calls: { name: string; value: string }[][] } {
  const calls: { name: string; value: string }[][] = [];
  const client = {
    runnerId,
    async setCredentials(credentials: { name: string; value: string }[]) {
      calls.push(credentials);
      if (behavior === 'throw') throw new Error('runner が応答しない\nstack: 値が混ざりうる行');
      return [];
    },
    calls,
  };
  return client as unknown as RunnerClient & { calls: { name: string; value: string }[][] };
}

function registry(clients: RunnerClient[]): RunnerRegistry {
  return { list: async () => clients } as unknown as RunnerRegistry;
}

describe('撒く先が両方とも出力に残る', () => {
  it('runner とクローンの両方へ撒き、台ごとに結果を返す', async () => {
    const a = fakeClient('runner-primary');
    const b = fakeClient('runner-2');
    const clone = createAgentTokenHolder();
    const spread = createTokenSpread({
      runners: registry([a, b]),
      clone,
      profileEnvNames: async () => [],
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    expect(results).toEqual([
      { target: 'runner-primary', ok: true },
      { target: 'runner-2', ok: true },
      { target: 'clone', ok: true },
    ]);
    expect(a.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: SECRET }]]);
    expect(clone.values()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET });
  });

  it('1台だけ落ちても、畳んで1つの成否にしない', async () => {
    const ok = fakeClient('runner-primary');
    const bad = fakeClient('runner-2', 'throw');
    const spread = createTokenSpread({
      runners: registry([ok, bad]),
      clone: createAgentTokenHolder(),
      profileEnvNames: async () => [],
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    expect(results.find((r) => r.target === 'runner-primary')?.ok).toBe(true);
    expect(results.find((r) => r.target === 'runner-2')?.ok).toBe(false);
    expect(results.find((r) => r.target === 'runner-2')?.error).toBe('runner が応答しない');
    expect(results.find((r) => r.target === 'runner-2')?.selfHealing).not.toBe(true);
  });

  it('繋がっている runner が0台なら、それを成功に畳まない', async () => {
    const spread = createTokenSpread({
      runners: registry([]),
      clone: createAgentTokenHolder(),
      profileEnvNames: async () => [],
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    const runner = results.find((r) => r.target === 'runner');
    expect(runner?.ok).toBe(false);
    expect(runner?.error).toContain('1台も無い');
    expect(runner?.selfHealing).toBe(true);
    expect(results.find((r) => r.target === 'clone')?.ok).toBe(true);
  });

  it('runner の一覧そのものが取れなくても落ちない（0台と同じ出口）', async () => {
    const spread = createTokenSpread({
      runners: { list: async () => Promise.reject(new Error('名簿が読めない')) } as never,
      clone: createAgentTokenHolder(),
      profileEnvNames: async () => [],
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    expect(results.find((r) => r.target === 'runner')?.ok).toBe(false);
    expect(results.find((r) => r.target === 'clone')?.ok).toBe(true);
  });
});

describe('値がどこにも出ない', () => {
  it('結果を JSON 化しても値が現れない（失敗した経路も含む）', async () => {
    const spread = createTokenSpread({
      runners: registry([fakeClient('runner-2', 'throw')]),
      clone: createAgentTokenHolder(),
      profileEnvNames: async () => ['CLAUDE_CODE_OAUTH_TOKEN'],
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    expect(JSON.stringify(results)).not.toContain(SECRET);
  });
});

describe('プロファイルが鍵を影にしている形', () => {
  it('撒くのはやめないが、上書きされることを出力に残す', async () => {
    const seen: string[][] = [];
    const spread = createTokenSpread({
      runners: registry([fakeClient('runner-primary')]),
      clone: createAgentTokenHolder(),
      profileEnvNames: async () => ['PATH', 'CLAUDE_CODE_OAUTH_TOKEN'],
      onShadowed: (names) => seen.push([...names]),
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    expect(results.find((r) => r.target === 'runner-primary')?.ok).toBe(true);
    const shadow = results.find((r) => r.target === 'profile-shadow');
    expect(shadow?.ok).toBe(false);
    expect(shadow?.error).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(seen).toEqual([['CLAUDE_CODE_OAUTH_TOKEN']]);
  });

  it('影が無ければ、その行を出さない', async () => {
    const spread = createTokenSpread({
      runners: registry([fakeClient('runner-primary')]),
      clone: createAgentTokenHolder(),
      profileEnvNames: async () => ['PATH'],
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    expect(results.find((r) => r.target === 'profile-shadow')).toBeUndefined();
  });

  it('プロファイルの名前が取れなくても落ちない（ただし影は検出できない）', async () => {
    const spread = createTokenSpread({
      runners: registry([fakeClient('runner-primary')]),
      clone: createAgentTokenHolder(),
      profileEnvNames: async () => Promise.reject(new Error('プロファイルが読めない')),
    });

    const results = await spread.spread({
      id: 'tok-a',
      generation: 2,
      kind: 'stored',
      value: SECRET,
    });

    expect(results.find((r) => r.target === 'runner-primary')?.ok).toBe(true);
    expect(results.find((r) => r.target === 'profile-shadow')).toBeUndefined();
  });
});

describe('クローンへの箱', () => {
  it('何も置いていなければ空（既定の構成の挙動を1文字も変えない）', () => {
    expect(createAgentTokenHolder().values()).toEqual({});
  });

  it('置き直すと新しい値になる（凍らない）', () => {
    const holder = createAgentTokenHolder();
    holder.set('first');
    expect(holder.values()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'first' });
    holder.set('second');
    expect(holder.values()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'second' });
  });
});

describe('createRunnerTokenSync（後から繋いだ runner を追いつかせる）', () => {
  function fakeRunner(): {
    setCredentials: (
      credentials: { name: string; value: string }[],
    ) => Promise<{ name: string; sha256: string; updatedAt: string }[]>;
    calls: { name: string; value: string }[][];
  } {
    const calls: { name: string; value: string }[][] = [];
    return {
      calls,
      async setCredentials(credentials) {
        calls.push(credentials);
        return [];
      },
    };
  }

  it('一度も撒いていなければ何もしない（setCredentials を呼ばない）', async () => {
    const holder = createAgentTokenHolder();
    const runner = fakeRunner();
    await createRunnerTokenSync(holder)(runner);
    expect(runner.calls).toEqual([]);
  });

  it('stored を撒いた後はその値を降ろす', async () => {
    const holder = createAgentTokenHolder();
    holder.set(SECRET, { tokenId: 'tok-a', generation: 1 });
    const runner = fakeRunner();
    await createRunnerTokenSync(holder)(runner);
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: SECRET }]]);
  });

  it('holder が落とされていたら空文字（鍵を消す指示）を降ろす', async () => {
    const holder = createAgentTokenHolder();
    holder.set(SECRET, { tokenId: 'tok-a', generation: 1 });
    holder.clear({ tokenId: 'tok-a', generation: 2 });
    const runner = fakeRunner();
    await createRunnerTokenSync(holder)(runner);
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' }]]);
  });
});

describe('現役が戻らなくなっても、資格箱を勝手に書き換えない', () => {
  it('現役の行を人間が消した後の reconsider() は、runner の資格箱に触らない', async () => {
    const runner = fakeClient('runner-primary');
    const clone = createAgentTokenHolder();
    const stores = createMemoryStores();
    const spread = createTokenSpread({
      runners: registry([runner]),
      clone,
      profileEnvNames: () => Promise.resolve([]),
    });
    const rotator = createTokenRotator({
      stores,
      spread,
      probe: { probe: async () => ({ verdict: 'usable' as const }) },
      now: () => new Date('2026-09-12T02:07:00.000Z'),
    });

    await stores.tokens.replace([
      {
        id: 'tok-b',
        label: 'second',
        value: 'value-b',
        order: 1,
        disabledAt: '2026-09-12T00:00:00.000Z',
      },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'ghost',
      generation: 3,
      rotatedAt: '2026-09-12T00:00:00.000Z',
    });

    await rotator.reconsider({ reason: 'tick' });

    expect(runner.calls).toEqual([]);
  });
});

describe('AgentTokenHolder#identity() は現役の鍵の指紋を添える（#2877 PR2）', () => {
  it('値を置いたら指紋が付き、値そのものは載らない。置き直せば指紋も変わる', () => {
    const holder = createAgentTokenHolder();
    holder.set(SECRET, { tokenId: 'tok-a', generation: 3 });

    const identity = holder.identity();

    expect(identity?.tokenId).toBe('tok-a');
    expect(identity?.generation).toBe(3);
    expect(identity?.fingerprint).toBe(fingerprintOf(SECRET));
    expect(JSON.stringify(identity)).not.toContain(SECRET);

    holder.set('sk-ant-oat-another', { tokenId: 'tok-b', generation: 4 });
    expect(holder.identity()?.fingerprint).toBe(fingerprintOf('sk-ant-oat-another'));
  });

  it('まだ何も置いていなければ身元は undefined（指紋を捏造しない）', () => {
    expect(createAgentTokenHolder().identity()).toBeUndefined();
  });
});
