import { describe, expect, it } from 'vitest';

import type { RunnerClient, RunnerRegistry } from '@alteroid/core';

import {
  createAgentTokenHolder,
  createRunnerTokenSync,
  createTokenSpread,
} from './token-spread.js';

/**
 * 現役を2か所へ撒く（Issue #393 PR3 の6段目）。
 *
 * **ここが固定するのは「撒いた」と「効いた」を混ぜないことである。** 撒く先が
 * 落ちても、片方だけ撒けても、プロファイルが影にしていても、**全部が出力に残る。**
 */

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
    // runner へ渡した鍵の名前。
    expect(a.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: SECRET }]]);
    // クローン側は箱に入って、次のセッションで読まれる。
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
    // **理由の1行目だけ採る**（2行目以降に値が混ざる形を減らす）。
    expect(results.find((r) => r.target === 'runner-2')?.error).toBe('runner が応答しない');
  });

  it('繋がっている runner が0台なら、それを成功に畳まない', async () => {
    // 畳むと、1台も繋がっていない状態で「回した」だけが日誌に残る。
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
    // クローンへは撒けている（同じプロセス内なので落ちない）。
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
    // **追加制限にしない**（撒くのをやめない）。ただし黙って効かない形にはしない。
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

    // 撒いてはいる。
    expect(results.find((r) => r.target === 'runner-primary')?.ok).toBe(true);
    // **結果にも載る**（`onShadowed` を1つ忘れただけで見えなくならないように）。
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
    // **取れなかったことを「影が無い」と読ませない**——検出できたときだけ印を
    // 出す形にしてあるので、ここでは印が出ないのが正しい。**それは「影が無い」
    // という主張ではない。**
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
    // 空を返すことで `#childEnv()` は器の環境変数だけの形と同じになる。
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

  it('一度も撒いていなければ setCredentials を呼ばない（器の環境変数だけの既定の構成のまま）', async () => {
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

  it('env 行を撒いた後は空文字（鍵を消す指示）を降ろす', async () => {
    // **これが直す穴である。** `clear()` は `current` だけを落とし `currentIdentity`
    // は残す——つまり「一度も撒いていない」と「env 行が現役」は holder 側では
    // 区別できるのに、直す前の `createRunnerTokenSync` はそれを見ずに `values()` の
    // 値の有無だけで判定していたので、ここで no-op になっていた
    // （繋ぎ直してきた runner の古い鍵ファイルを消せない、という穴）。
    const holder = createAgentTokenHolder();
    holder.set(SECRET, { tokenId: 'tok-a', generation: 1 });
    holder.clear({ tokenId: 'tok-a', generation: 2 });
    const runner = fakeRunner();
    await createRunnerTokenSync(holder)(runner);
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' }]]);
  });
});
