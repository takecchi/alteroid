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
/**
 * クローンの器（デーモンのプロセス）に在る認証トークン。**`source: 'env'` の行を
 * 撒くときの値である**（2026-09-11 の人間の決定。以前は空文字を撒いて runner の
 * 環境変数へ落ちることを期待していた）。
 */
const ENV_TOKEN = 'sk-ant-oat-from-clone-env';

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

/**
 * **env の行も、値を持って runner へ降りる**（人間の決定 2026-09-11）。
 *
 * 以前は空文字を撒き、runner が**自分の環境変数へ落ちる**ことを期待していた。
 * その形は2つを同時に作っていた:
 *
 * 1. **runner が単体で動く器になる**（鍵をクローンからもらう必要が無い）
 * 2. **runner の env の値は現役とは別物でありうる** —— 本番実測（2026-09-11）で、
 *    runner の env に在ったのは週次上限で冷却中のトークンだった
 */
describe('env の行（器の環境変数を指す行）を撒くとき', () => {
  it('空文字ではなく、クローンの器の env の値を runner へ降ろす', async () => {
    const runner = fakeClient('runner-primary');
    const clone = createAgentTokenHolder();
    const spread = createTokenSpread({
      agentTokenFromEnv: () => ENV_TOKEN,
      runners: registry([runner]),
      clone,
      profileEnvNames: () => Promise.resolve([]),
    });

    const results = await spread.spread({ id: 'tok-env', generation: 3, kind: 'env' });

    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: ENV_TOKEN }]]);
    expect(results.filter((entry) => !entry.ok)).toEqual([]);
  });

  it('holder にも同じ値を置く（名乗り直しの降ろし直しが鍵を消さない）', async () => {
    // **撒く側と名乗り直し側で出所が割れていると、繋ぎ直した runner が撒いたはずの
    // 鍵を失う**（`createRunnerTokenSync` は holder を見る）。
    const runner = fakeClient('runner-primary');
    const clone = createAgentTokenHolder();
    const spread = createTokenSpread({
      agentTokenFromEnv: () => ENV_TOKEN,
      runners: registry([runner]),
      clone,
      profileEnvNames: () => Promise.resolve([]),
    });

    await spread.spread({ id: 'tok-env', generation: 3, kind: 'env' });

    expect(clone.values()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: ENV_TOKEN });
    expect(clone.identity()).toEqual({ tokenId: 'tok-env', generation: 3 });

    // 名乗り直しでも同じ値が降りる（空文字にならない）。身元が在るので
    // 器の環境変数（別のダミー）は見ない。
    const again = fakeClient('runner-2');
    await createRunnerTokenSync(clone, () => 'dummy-should-not-be-used')(again);
    expect(again.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: ENV_TOKEN }]]);
  });

  it('器の env に値が無ければ、撒けなかったことを出力に残す（黙って runner の env へ倒さない）', async () => {
    const runner = fakeClient('runner-primary');
    const clone = createAgentTokenHolder();
    const spread = createTokenSpread({
      agentTokenFromEnv: () => undefined,
      runners: registry([runner]),
      clone,
      profileEnvNames: () => Promise.resolve([]),
    });

    const results = await spread.spread({ id: 'tok-env', generation: 3, kind: 'env' });

    // 「鍵を消す指示」として降りる（古い鍵を器に残さない）
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' }]]);
    // **そして、撒く値が無かったことが出力に在る。**
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'clone-env',
          ok: false,
          error: expect.stringContaining('資格を1つも持たずに走る'),
        }),
      ]),
    );
    expect(clone.values()).toEqual({});
  });
});

describe('撒く先が両方とも出力に残る', () => {
  it('runner とクローンの両方へ撒き、台ごとに結果を返す', async () => {
    const a = fakeClient('runner-primary');
    const b = fakeClient('runner-2');
    const clone = createAgentTokenHolder();
    const spread = createTokenSpread({
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
      // 器の環境変数の値（既定の検証ではクローンの器にトークンが在る前提）。
      agentTokenFromEnv: () => ENV_TOKEN,
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
   * **⚠️ 2026-09-12（#866）に期待を反転した。** 元の題は「一度も撒いていなければ
   * setCredentials を呼ばない（器の環境変数だけの既定の構成のまま）」で、
   * 「箱が空 ⟹ runner は自分の環境変数の鍵をそのまま使える」という前提の上で
   * 正しかった。`runner.ts` の `#childEnv()` はいまその鍵を無条件に削除する
   * （人間の決定 2026-09-11）ので、何もしなければ繋ぎ直した runner は資格を
   * 1本も持たずに走り続ける——本番で全マネージャーが `Not logged in` に
   * 落ちた実害（Issue #866）がこれである。いま「箱が空」は「器の環境変数の
   * 値をそのまま降ろす」に変わった。
   */
  it('一度も撒いていなければ、器の環境変数の値を降ろす（#866）', async () => {
    const holder = createAgentTokenHolder();
    const runner = fakeRunner();
    await createRunnerTokenSync(holder, () => 'dummy-not-a-real-token')(runner);
    expect(runner.calls).toEqual([
      [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'dummy-not-a-real-token' }],
    ]);
  });

  it('一度も撒いておらず、器にも値が無ければ空文字（鍵を消す指示）を降ろす', async () => {
    const holder = createAgentTokenHolder();
    const runner = fakeRunner();
    await createRunnerTokenSync(holder, () => undefined)(runner);
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' }]]);
  });

  it('stored を撒いた後はその値を降ろす（身元が在れば器の環境変数は見ない）', async () => {
    const holder = createAgentTokenHolder();
    holder.set(SECRET, { tokenId: 'tok-a', generation: 1 });
    const runner = fakeRunner();
    // **器の環境変数の値（別のダミー）を渡しても、身元が在るなら無視される。**
    // これが降りたら「身元があるのに env 側を読んでしまっている」という
    // 実装ミスである。
    await createRunnerTokenSync(holder, () => 'dummy-should-not-be-used')(runner);
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: SECRET }]]);
  });

  it('holder が落とされていたら空文字（鍵を消す指示）を降ろす', async () => {
    // **⚠️ 2026-09-11 に題を差し替えた。** 元の題は「env 行を撒いた後は空文字（鍵を
    // 消す指示）を降ろす」だった —— env の行は空文字で撒く、という前提だったため。
    // **いま env の行はデーモンの env の値を持って降りる**ので、holder が落ちるのは
    // 「配る値がどこにも無い」ときだけである（`spread` の `clone.clear` の doc）。
    // 測っている中身（holder が空 ＋ 身元が在る ⟹ 空文字を降ろす）は同じである。
    // **これが直す穴である。** `clear()` は `current` だけを落とし `currentIdentity`
    // は残す——つまり「一度も撒いていない」と「env 行が現役」は holder 側では
    // 区別できるのに、直す前の `createRunnerTokenSync` はそれを見ずに `values()` の
    // 値の有無だけで判定していたので、ここで no-op になっていた
    // （繋ぎ直してきた runner の古い鍵ファイルを消せない、という穴）。
    const holder = createAgentTokenHolder();
    holder.set(SECRET, { tokenId: 'tok-a', generation: 1 });
    holder.clear({ tokenId: 'tok-a', generation: 2 });
    const runner = fakeRunner();
    // **身元が在るので、器の環境変数（別のダミー）は見ない。**
    await createRunnerTokenSync(holder, () => 'dummy-should-not-be-used')(runner);
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: '' }]]);
  });
});

/**
 * **配達の端から端まで1本で測る（#869）。**
 *
 * ⭐ **ここが答えるのは「`reconsider()` の中で関数が呼ばれたか」ではない。**
 * 「**`reconsider()` が返った後、これから起こす子プロセスへ渡る資格の箱に、値が
 * 入っているか**」である —— `RunnerClient#setCredentials` が受け取ったものが、
 * runner の `CredentialStore` に入り、`Host#childEnv()` がそれを
 * **これから起こすマネージャー／作業者の env** へ重ねる（`runner.ts` の
 * `#childEnv()` は `ROTATABLE_CREDENTIAL_KEYS` を無条件に削除してから、この箱を
 * 重ね直す。人間の決定 2026-09-11）。
 *
 * ⚠️ **`#childEnv()` の中まで測る形は取れない**（private で、core の外の配線に
 * 依存する）。**`setCredentials` はその手前の、観測できる最後の点である。**
 * ⟹ **ここが空なら、その後に起こる子プロセスには資格が1本も無い。**
 */
describe('起動後に現役が戻らなくなっても、これから起こす子プロセスへ資格が届く（#869）', () => {
  it('現役の行を人間が消した後の reconsider() で、runner の資格箱に値が入る', async () => {
    const runner = fakeClient('runner-primary');
    const clone = createAgentTokenHolder();
    const stores = createMemoryStores();
    const spread = createTokenSpread({
      agentTokenFromEnv: () => ENV_TOKEN,
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

    // 🔴 **これが空配列なら、この後に起こすマネージャーは資格ゼロで走る。**
    expect(runner.calls).toEqual([[{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: ENV_TOKEN }]]);
    // **人間が外した行の値ではない。**
    expect(JSON.stringify(runner.calls)).not.toContain('value-b');
  });
});
