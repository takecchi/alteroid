import { describe, expect, it } from 'vitest';

import {
  createMemoryStores,
  createTokenRotator,
  type RunnerClient,
  type RunnerRegistry,
} from '@alteroid/core';

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
    // #1383: 配布を試みて実際に落ちた失敗は、自己修復する（無害な）失敗ではない。
    expect(results.find((r) => r.target === 'runner-2')?.selfHealing).not.toBe(true);
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
    // #1383: これは配布そのものの失敗ではなく、まだ相手（runner）が居ないだけ
    // ——後から runner が繋がれば createRunnerTokenSync が追いつかせる（自己修復）。
    // `describeSpread` はこの印を見て、配布失敗と同じ「置けなかった」で出さない。
    expect(runner?.selfHealing).toBe(true);
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

  /**
   * **⚠️ 2026-09-14 に、器の環境変数へのフォールバックを完全に廃止した。**
   * 2026-09-12〜2026-09-14（#866）のあいだは、箱が空（＝一度も撒いていない）
   * ときに器の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）の値をそのまま降ろす手当てが
   * 入っていたが、その手当てごと撤去した——トークンプールは100% DB 駆動にする、
   * という人間の決定による。⟹ **箱が空のときは何もしない**（`setCredentials`
   * を1回も呼ばない）。プールから一度も撒いていない器では、後から繋ぎ直した
   * runner も資格を持たずに走る——直すのは `alteroid token add` で通る鍵を
   * 登録し、それが撒かれるのを待つことである。
   */
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
    // **身元は在るが値が無い状態**（`clear()` は `current` だけを落とし
    // `currentIdentity` は残す）。**「一度も撒いていない」（身元も無い）とは
    // 区別する** ——こちらは「撒く値そのものが取れなかった」という別の状態
    // なので、空文字（＝鍵を消す指示）を降ろす。
    const holder = createAgentTokenHolder();
    holder.set(SECRET, { tokenId: 'tok-a', generation: 1 });
    holder.clear({ tokenId: 'tok-a', generation: 2 });
    const runner = fakeRunner();
    await createRunnerTokenSync(holder)(runner);
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' }]]);
  });
});

/**
 * **配達の端から端まで1本で測る。**
 *
 * ⭐ **ここが答えるのは「`reconsider()` の中で関数が呼ばれたか」ではない。**
 * 「**`reconsider()` が返った後、これから起こす子プロセスへ渡る資格の箱に、値が
 * 変わっていないか**」である —— `RunnerClient#setCredentials` が受け取ったものが、
 * runner の `CredentialStore` に入り、`Host#childEnv()` がそれを
 * **これから起こすマネージャー／作業者の env** へ重ねる。
 *
 * **⚠️ 2026-09-14 に、器の環境変数へのフォールバックを完全に廃止した。** かつて
 * （#869）はここで「現役が待っても戻らない状態になっても、器の環境変数の値が
 * 資格箱に届く」ことを固定していたが、その手当てごと撤去した——トークンプールは
 * 100% DB 駆動にする、という人間の決定による。⟹ いまは `exhausted` の道では
 * `spread()` が一度も呼ばれないので、**資格箱にはそれ以前の値がそのまま残る**
 * （新しい値でもフォールバック値でもない）。
 */
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

    // **起動後に現役の行が消えた**（人間が消した）。残りは人間が外してあるので、
    // 回す先の候補は1本も立たない ＝ `exhausted` の道。
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

    // **`exhausted` は何も撒かないので、runner の資格箱は1回も呼ばれていない。**
    expect(runner.calls).toEqual([]);
  });
});
