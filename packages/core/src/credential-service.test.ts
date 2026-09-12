import { describe, expect, it } from 'vitest';

import { createCredentialService, resolveCredentialRows } from './credential-service.js';
import { fingerprintOf, type CredentialEntry } from './credentials.js';
import type { RunnerClient, RunnerCredentialFingerprint } from './runner-protocol.js';
import type { StoredCredential } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * マネージャーへ降ろす環境変数の正本（名前→値の袋）。
 *
 * ここが守っているのは4つである:
 *
 * 1. **任意の名前が置ける**（用途が増えるたびに実装を直さない）
 * 2. **2つ目の正本を作らせない**（プールが持つ名前は拒む）
 * 3. **伏せる鍵を鍵として配らせない**（器の側と同じ拒否を、早い位置にも置く）
 * 4. **移行の途中で資格を消さない**（正本が空のときに空を配らない）
 */

const WITHHELD = ['ALTEROID_DATABASE_URL', 'ALTEROID_RUNNER_TOKEN'] as const;

/** 降ってきた鍵をそのまま覚える runner。 */
function fakeRunner(runnerId = 'runner-test') {
  const received: CredentialEntry[][] = [];
  const held = new Map<string, string>();
  /**
   * **`credentials()` を経由しない。** 検証で `credentials()` を落とす回がある
   * ので（「指紋が取れないとき」）、`setCredentials` の戻りをそこへ通すと、
   * 落としたいのは読みだけなのに書きまで落ちる＝偽物が本物と違う壊れ方をする。
   */
  const fingerprints = (): RunnerCredentialFingerprint[] =>
    [...held].map(([name, value]) => ({
      name,
      sha256: fingerprintOf(value),
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
  const runner = {
    runnerId,
    workspacePath: '/work',
    received,
    held,
    async credentials(): Promise<RunnerCredentialFingerprint[]> {
      return fingerprints();
    },
    async setCredentials(entries: CredentialEntry[]): Promise<RunnerCredentialFingerprint[]> {
      received.push(entries);
      for (const entry of entries) {
        if (entry.value.length === 0) held.delete(entry.name);
        else held.set(entry.name, entry.value);
      }
      return fingerprints();
    },
  };
  return runner as unknown as RunnerClient & {
    received: CredentialEntry[][];
    held: Map<string, string>;
  };
}

function registryOf(runners: RunnerClient[]) {
  return {
    async list() {
      return runners;
    },
    async get(id: string) {
      return runners.find((runner) => runner.runnerId === id) ?? null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;
}

function serviceOf(runners: RunnerClient[] = [], env: NodeJS.ProcessEnv = {}) {
  const stores = createMemoryStores();
  /**
   * クローンとの食い違いを知らせた回（#865）。**名前の配列しか受け取らない**
   * ——値も指紋も渡らないことを、この型そのものが固定している。
   */
  const shadowNotices: readonly string[][] = [];
  const service = createCredentialService({
    stores,
    runners: registryOf(runners),
    withheldEnvKeys: [...WITHHELD],
    // **器の env を明示で渡す（既定の `process.env` に依らせない）。** 既定のままだと、
    // 検証を走らせた機械に `GH_TOKEN` が在るかどうかで結果が変わる ——
    // 実際、`env` の土台を足した直後にこのファイルの5本がそれで落ちた。
    env,
    onCloneEnvShadowed: (names) => {
      (shadowNotices as string[][]).push([...names]);
    },
  });
  return { stores, service, shadowNotices };
}

describe('置いて配る', () => {
  it('表に無い名前でも置けて、そのまま runner へ降りる', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);

    const result = await service.apply([
      { name: 'GIT_AUTHOR_NAME', value: 'takecchi' },
      { name: 'NPM_TOKEN', value: 'npm_x' },
    ]);

    // 正本に在る（値つき）
    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'GIT_AUTHOR_NAME', value: 'takecchi' }),
      expect.objectContaining({ name: 'NPM_TOKEN', value: 'npm_x' }),
    ]);
    // runner にも降りた
    expect(runner.held.get('GIT_AUTHOR_NAME')).toBe('takecchi');
    expect(runner.held.get('NPM_TOKEN')).toBe('npm_x');
    // 返すのは指紋だけ（値は1文字も出さない）
    expect(JSON.stringify(result.fingerprints)).not.toContain('npm_x');
    expect(result.fingerprints.map((entry) => entry.name)).toEqual([
      'GIT_AUTHOR_NAME',
      'NPM_TOKEN',
    ]);
    expect(result.runners).toEqual([
      expect.objectContaining({ runnerId: 'runner-test', ok: true }),
    ]);
  });

  it('入力に無い名前は触らない（部分更新である）', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);

    await service.apply([{ name: 'GH_TOKEN', value: 'ghp_1' }]);
    await service.apply([{ name: 'GIT_AUTHOR_NAME', value: 'takecchi' }]);

    expect((await stores.credentials.list()).map((row) => row.name)).toEqual([
      'GH_TOKEN',
      'GIT_AUTHOR_NAME',
    ]);
    expect(runner.held.get('GH_TOKEN')).toBe('ghp_1');
  });

  it('空文字は「外す」で、外す指示も runner へ配る（外したのに効いている、を作らない）', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);

    await service.apply([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    await service.apply([{ name: 'NPM_TOKEN', value: '' }]);

    expect(await stores.credentials.list()).toEqual([]);
    // 正本から消えた行は「残っている行」には出てこないので、**空文字として**
    // 配られていなければ runner に残る
    expect(runner.held.has('NPM_TOKEN')).toBe(false);
    expect(runner.received.at(-1)).toEqual([{ name: 'NPM_TOKEN', value: '' }]);
  });

  it('runner が1台落ちても、落ちた事実が台ごとに返る（畳んで1つの成否にしない）', async () => {
    const ok = fakeRunner('runner-ok');
    const broken = fakeRunner('runner-broken');
    broken.setCredentials = async () => {
      throw new Error('つながらない');
    };
    const { stores, service } = serviceOf([ok, broken]);

    const result = await service.apply([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    expect(result.runners).toEqual([
      expect.objectContaining({ runnerId: 'runner-ok', ok: true }),
      expect.objectContaining({ runnerId: 'runner-broken', ok: false }),
    ]);
    // **正本は書けている。** 配れなかった台は次に名乗ったときに追いつく
    expect((await stores.credentials.list()).map((row) => row.name)).toEqual(['NPM_TOKEN']);
  });
});

describe('置かせない名前', () => {
  it('プールが正本を持つ名前は拒む（回した鍵を名乗り直しで巻き戻さない）', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);

    await expect(
      service.apply([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-stolen' }]),
    ).rejects.toThrow(/alteroid token add/);

    // **1文字も書いていない**（落ちるなら、何も書く前に落ちる）
    expect(await stores.credentials.list()).toEqual([]);
    expect(runner.received).toEqual([]);
  });

  it('同じバッチに正しい鍵が混じっていても、全部書かない（部分適用にしない）', async () => {
    const { stores, service } = serviceOf([fakeRunner()]);

    await expect(
      service.apply([
        { name: 'NPM_TOKEN', value: 'npm_x' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-stolen' },
      ]),
    ).rejects.toThrow();

    expect(await stores.credentials.list()).toEqual([]);
  });

  it('伏せる鍵は拒む（消したものを鍵の名前で注入し直せない）', async () => {
    const { stores, service } = serviceOf([fakeRunner()]);

    await expect(
      service.apply([{ name: 'ALTEROID_DATABASE_URL', value: 'postgres://stolen' }]),
    ).rejects.toThrow();
    expect(await stores.credentials.list()).toEqual([]);
  });

  it('器の外を指す名前は拒む（正本はファイル名にもなる）', async () => {
    const { service } = serviceOf();

    for (const name of ['../../../etc/cron.d/x', 'a/b', 'gh_token', '']) {
      await expect(service.apply([{ name, value: 'x' }])).rejects.toThrow();
    }
  });

  it('同じ名前を2回渡したら拒む（前の行が黙って捨てられない）', async () => {
    const { service } = serviceOf();

    await expect(
      service.apply([
        { name: 'NPM_TOKEN', value: 'first' },
        { name: 'NPM_TOKEN', value: 'second' },
      ]),
    ).rejects.toThrow(/2回/);
  });

  it('空のバッチは拒む（置くものが無い呼びを成功と言わない）', async () => {
    const { service } = serviceOf();

    await expect(service.apply([])).rejects.toThrow();
  });
});

describe('名乗ってきた runner へ降ろし直す', () => {
  /**
   * **⚠️ このテストは 2026-09-11 に期待値を反転した。** 元の題と本文は下に残してある。
   *
   * 元: 「正本が空なら1文字も配らない（器の環境変数から拾った鍵を消して回らない）」
   * ——runner が**自分の env から種を拾う器**だったので、空を配るとその種を消して
   * 回る形になり、移行の途中で資格が消えるためだった。
   *
   * **その前提が無くなった**（人間の決定 2026-09-11）。runner は自分の env から
   * 1文字も拾わない（`apps/runner/src/index.ts` の `seed: {}`、`runner.ts` の
   * `#childEnv()`）。⟹ **配らなければ鍵はどこにも無い。** だから「正本が空」のときに
   * 見るべきものは「配らないこと」ではなく、**クローンの器の env から配ること**である。
   *
   * **保証は弱くなっていない。** 守る対象が「runner の種を消さない」から
   * 「鍵の出所をクローン1つに保つ」へ移り、後者のほうが強い（runner の env に
   * 何が在っても子には届かない）。
   */
  it('正本が空でも、クローンの器の env に在れば配る（配らなければ鍵はどこにも無い）', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner], { GH_TOKEN: 'ghp_from_clone_env' });

    const result = await service.syncRunner(runner);

    expect(result?.map((entry) => entry.name)).toEqual(['GH_TOKEN']);
    expect(runner.held.get('GH_TOKEN')).toBe('ghp_from_clone_env');
    // **正本は書き換えない。** 器の env は「最後の土台」であって正本ではない
    expect(await stores.credentials.list()).toEqual([]);
  });

  it('正本にも器の env にも無ければ、1文字も配らない（「全部外せ」とは言わない）', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner], {});

    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toEqual([]);
  });

  /**
   * **⚠️ このテストは 2026-09-12 に期待値を反転した。** 元の題と本文は下に
   * 残してある（north_star「テストを弱めずに直す」——現行の欠陥を仕様として
   * 固定していたテストを反転させる条件は3つ: テストを消さず期待値を反転する
   * / 元のコメントを消さず経緯を追記する / PR 本文に3点セットを書く）。
   *
   * 元: 「正本が在れば器の env より正本が勝つ（人間が明示的に置いたほうを
   * 配る）」——GH_TOKEN について、正本の行が器の env より優先されていた。
   *
   * **その前提が無くなった**（人間の決定 2026-09-12、Issue #865 の恒久策）。
   * GitHub の名前（`GH_TOKEN` / `GITHUB_TOKEN`）は、クローンの器の env に
   * 空でない値が在れば、正本の行より優先して配られる——オーナーの仕様
   * 「クローンへ渡す環境変数と同じものをマネージャーへ渡す」を満たすため
   * である（`resolveCredentialRows` のdoc）。
   *
   * **保証は弱くなっていない。** 守る対象が「正本の行を人間が置けば必ず
   * 効く」から「マネージャーとクローンが常に同じ値で走る」へ移った——
   * 後者のほうが Issue #865 の実害（2つの主体が別の鍵で走る）を直接塞ぐ。
   */
  it('GitHub の名前は、正本が在っても器の env のほうが勝つ（クローンと同じ値で走らせる。#865）', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner], { GH_TOKEN: 'ghp_from_clone_env' });
    await service.apply([{ name: 'GH_TOKEN', value: 'ghp_from_vault' }]);
    runner.received.length = 0;

    await service.syncRunner(runner);

    expect(runner.held.get('GH_TOKEN')).toBe('ghp_from_clone_env');
  });

  it('GitHub 以外の任意の名前は、従来どおり正本が勝つ（優先順位は GitHub だけに限る）', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner], { NPM_TOKEN: 'from_clone_env' });
    await service.apply([{ name: 'NPM_TOKEN', value: 'from_vault' }]);
    runner.received.length = 0;

    await service.syncRunner(runner);

    expect(runner.held.get('NPM_TOKEN')).toBe('from_vault');
  });

  it('プールが正本を持つ名前は、器の env に在っても配らない（撒き手を2つにしない）', async () => {
    // **回し手（`token-spread.ts`）が撒く名前である。** ここが同じ名前を降ろすと、
    // 名乗り直しのたびに回した鍵を巻き戻す。
    const runner = fakeRunner();
    const { service } = serviceOf([runner], { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-from-env' });

    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toEqual([]);
  });

  it('指紋が同じものは降ろさない（再接続のたびにセッションを畳ませない）', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner]);
    await service.apply([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    runner.received.length = 0;

    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toEqual([]);
  });

  it('器が作り直されたら、正本に在るものを降ろし直す', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner]);
    await service.apply([
      { name: 'NPM_TOKEN', value: 'npm_x' },
      { name: 'GIT_AUTHOR_NAME', value: 'takecchi' },
    ]);

    // 器ごと入れ替わった（Railway には volume が無い）
    runner.held.clear();
    runner.received.length = 0;

    const result = await service.syncRunner(runner);

    expect(result?.map((entry) => entry.name).sort()).toEqual(['GIT_AUTHOR_NAME', 'NPM_TOKEN']);
    expect(runner.held.get('NPM_TOKEN')).toBe('npm_x');
  });

  it('差があるものだけを降ろす', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner]);
    await service.apply([
      { name: 'NPM_TOKEN', value: 'npm_x' },
      { name: 'GIT_AUTHOR_NAME', value: 'takecchi' },
    ]);

    // 片方だけ器の側で古くなった
    runner.held.set('NPM_TOKEN', 'npm_old');
    runner.received.length = 0;

    await service.syncRunner(runner);

    expect(runner.received).toEqual([[{ name: 'NPM_TOKEN', value: 'npm_x' }]]);
  });

  it('指紋が取れないときは降ろす（降ろし損なうより、同じ値を書き直すほうが安全側）', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner]);
    await service.apply([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    runner.received.length = 0;
    runner.credentials = async () => {
      throw new Error('答えられない');
    };

    await service.syncRunner(runner);

    expect(runner.received).toEqual([[{ name: 'NPM_TOKEN', value: 'npm_x' }]]);
  });
});

describe('同時に更新されたとき', () => {
  /**
   * **重なりそのものを見る。** 最終状態だけを見るテストにすると、直列化していない
   * 実装でもたまたま揃って通る（`profile-service.test.ts` の `tripwire` と同じ
   * 理由）。ここでは「1更新の全段が終わる前に次が始まったか」を直接数える。
   */
  it('層ごとに違う値が残らない（正本と runner が同じ値で揃う）', async () => {
    const runner = fakeRunner();
    const stores = createMemoryStores();

    const violations: string[] = [];
    let busy = false;

    // 正本への書き込みを止めて、2本目を確実に重ねる
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;

    const put = stores.credentials.put.bind(stores.credentials);
    stores.credentials.put = async (entries) => {
      writes += 1;
      if (busy) violations.push('前の更新が終わる前に次の更新が始まった');
      busy = true;
      if (writes === 1) await blocked;
      return put(entries);
    };

    const push = runner.setCredentials.bind(runner);
    runner.setCredentials = async (entries) => {
      const result = await push(entries);
      busy = false;
      return result;
    };

    const service = createCredentialService({
      stores,
      runners: registryOf([runner]),
      withheldEnvKeys: [...WITHHELD],
    });

    const first = service.apply([{ name: 'WHICH', value: 'A' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = service.apply([{ name: 'WHICH', value: 'B' }]);
    release?.();
    await Promise.all([first, second]);

    expect(violations).toEqual([]);
    // 正本と器が同じ値で揃っている（どちらが後だったかは問わない）
    const stored = (await stores.credentials.list()).find((row) => row.name === 'WHICH');
    expect(stored?.value).toBe(runner.held.get('WHICH'));
  });
});

/**
 * **クローンとマネージャーが別の鍵で走っていることを検出する（#865）。**
 *
 * ⭐ **これは挙動の歯ではなく、観測の歯である。** ここが固定するのは
 * `shadowsCloneEnv` が**いつ立つか**（検出条件）だけで、**立ったときに
 * どちらの値が実際に配られるか**（勝敗）はここでは測らない——勝敗は
 * `resolveCredentialRows` の歯（下の別の describe）が固定する。
 *
 * **⚠️ 2026-09-12 より前は「正本が勝つ」が勝敗の全部だったので、この2つは
 * 同じ節で測れていた。** いまは GitHub の名前（`GITHUB_CREDENTIAL_NAMES`）に
 * ついて器の env が勝つよう反転しているので（`it('GitHub の名前は、正本が
 * 在っても器の env のほうが勝つ（クローンと同じ値で走らせる。#865）')`）、
 * **検出条件（この節）と勝敗（`resolveCredentialRows` の節）は別の主張になった。
 * 検出条件そのものは変わっていない**（正本に行が在り・器の env にも空でない
 * 別の値が在り・GitHub の名前であること）。
 *
 * ここが守っているのは1つだけ: **食い違っていることに、誰かが気づけること。**
 * 実測（#865）では、マネージャーが GitHub App の user-to-server トークンで、
 * クローンが classic PAT で走っていた —— **どちらの層も自分は正常に見えており、
 * 気づける経路は「マネージャーが 403 で止まって人間が原因を追う」しか無かった。**
 */
describe('クローンとマネージャーで別の鍵が配られていることを検出する（#865）', () => {
  /** 実在の鍵と紛れない形（`token-rotator.test.ts` の `dummy-not-a-real-token` と同じ作法）。 */
  const VAULT = 'dummy-not-a-real-token-vault';
  const CLONE_ENV = 'dummy-not-a-real-token-clone-env';

  it('正本と器の env に同じ名前で別の値が在れば、旗が立つ', async () => {
    const { service } = serviceOf([], { GH_TOKEN: CLONE_ENV });
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);

    expect(await service.fingerprints()).toEqual([
      expect.objectContaining({ name: 'GH_TOKEN', shadowsCloneEnv: true }),
    ]);
  });

  it('同じ値なら立たない（食い違っていない）', async () => {
    const { service } = serviceOf([], { GH_TOKEN: VAULT });
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);

    // **`false` を敷き詰めない。** 旗そのものが付かない。
    expect((await service.fingerprints())[0]).not.toHaveProperty('shadowsCloneEnv');
  });

  it('正本にしか無ければ立たない（effective() が正本を配るので両者は揃う）', async () => {
    const { service } = serviceOf([], {});
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);

    expect((await service.fingerprints())[0]).not.toHaveProperty('shadowsCloneEnv');
  });

  it('器の env にしか無ければ立たない（正本に行が無いので effective() が env から埋める）', async () => {
    const { service } = serviceOf([], { GH_TOKEN: CLONE_ENV });

    // 正本が空なので、そもそも並べる行が無い。
    expect(await service.fingerprints()).toEqual([]);
  });

  it('器の env の値が空文字なら立たない（空は「置かれていない」と同じ）', async () => {
    const { service } = serviceOf([], { GH_TOKEN: '' });
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);

    expect((await service.fingerprints())[0]).not.toHaveProperty('shadowsCloneEnv');
  });

  it('GitHub 以外の名前では立たない（見るのは GITHUB_CREDENTIAL_NAMES だけ）', async () => {
    // **身元は GitHub の名前ではない。** ここを見ると、クローンが自分の身元で
    // コミットし、マネージャーが正本の身元でコミットする**正常な構成**まで
    // 食い違いとして出てしまう。
    const { service } = serviceOf([], { GIT_AUTHOR_NAME: 'from-clone-env' });
    await service.apply([{ name: 'GIT_AUTHOR_NAME', value: 'from-vault' }]);

    expect((await service.fingerprints())[0]).not.toHaveProperty('shadowsCloneEnv');
  });

  it('プールが正本を持つ名前では立たない（比べる相手がそもそも違う）', async () => {
    // **`apply()` は経由できない。** あちらは `CLAUDE_CODE_OAUTH_TOKEN` を
    // 「正本はプールの側である」と拒むので（`assertEntries`）、この状態は
    // 正規の口からは作れない。**それでも門を測る** —— 記憶ストアを直に
    // 書けば作れてしまう状態であり、門が消えたことに気づける経路は他に無い。
    //
    // **立ってはいけない理由**: クローンが実際に使う `CLAUDE_CODE_OAUTH_TOKEN` は
    // 正本でも器の env でもなく、回し手（`token-spread.ts`）が撒いた値である。
    // ここで正本と器の env を比べても、**クローンが本当に使っている値とは
    // 無関係な比較**になり、誤検出しか生まない。
    const { stores, service } = serviceOf([], { CLAUDE_CODE_OAUTH_TOKEN: CLONE_ENV });
    await stores.credentials.put([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: VAULT }]);

    expect((await service.fingerprints())[0]).not.toHaveProperty('shadowsCloneEnv');
  });

  it('syncRunner が食い違いを知らせる。ただし同じ食い違いは繰り返さない', async () => {
    const runner = fakeRunner();
    const { service, shadowNotices } = serviceOf([runner], { GH_TOKEN: CLONE_ENV });
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);

    await service.syncRunner(runner);
    await service.syncRunner(runner);

    // **1回だけ。** `syncRunner` は runner が名乗り直すたびに叩かれるので、
    // 毎回出すと同じ1行で日誌が埋まり、意味のある行が埋もれる。
    expect(shadowNotices).toEqual([['GH_TOKEN']]);
  });

  it('食い違いが無ければ、一度も知らせない', async () => {
    const runner = fakeRunner();
    const { service, shadowNotices } = serviceOf([runner], { GH_TOKEN: VAULT });
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);

    await service.syncRunner(runner);

    expect(shadowNotices).toEqual([]);
  });

  it('値も指紋も、旗にも知らせにも出ない', async () => {
    const runner = fakeRunner();
    const { service, shadowNotices } = serviceOf([runner], { GH_TOKEN: CLONE_ENV });
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);
    await service.syncRunner(runner);

    const fingerprints = JSON.stringify(await service.fingerprints());
    const notices = JSON.stringify(shadowNotices);
    for (const secret of [VAULT, CLONE_ENV, fingerprintOf(CLONE_ENV)]) {
      expect(notices).not.toContain(secret);
    }
    // **旗の側には正本の指紋だけが載る**（元から載っているもの）。
    // **器の env の側の指紋は、どこにも出さない。**
    expect(fingerprints).not.toContain(VAULT);
    expect(fingerprints).not.toContain(CLONE_ENV);
    expect(fingerprints).not.toContain(fingerprintOf(CLONE_ENV));
  });

  /**
   * **⚠️ このテストは 2026-09-12 に期待値を反転した。** 元の題と本文は下に
   * 残してある。
   *
   * 元: 「🔴 旗が立っていても、配るのは正本の値のままである（挙動を変えて
   * いない）」——2026-09-11 時点では、`shadowsCloneEnv` は検出専用で勝敗には
   * 手を出さなかった。
   *
   * **その前提が無くなった**（人間の決定 2026-09-12、Issue #865 の恒久策）。
   * GitHub の名前については、旗が立つ条件（正本と器の env が食い違う）が
   * まさに「器の env が優先して配られる」条件と重なる——`resolveCredentialRows`
   * が両方を同じ入力から決めるため。**⟹ 旗が立っているとき、配られるのは
   * もう正本の値ではない。**
   */
  it('🔴 旗が立っているとき、実際に配られるのは器の env の値である（挙動が変わった。#865）', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner], { GH_TOKEN: CLONE_ENV });
    await service.apply([{ name: 'GH_TOKEN', value: VAULT }]);
    runner.received.length = 0;

    await service.syncRunner(runner);

    // **検出条件どおりに勝敗が決まる。** ここが `VAULT` に戻ったら、
    // GitHub の名前の優先順位が反転前に巻き戻っている。
    expect(runner.held.get('GH_TOKEN')).toBe(CLONE_ENV);
  });
});

/**
 * `resolveCredentialRows` そのものを固定する（人間の決定 2026-09-12、
 * 「梯子を1本に統一する」——Issue #865 の恒久策）。
 *
 * **この関数の出力が、マネージャー側（`effective()` 経由）とクローン側
 * （`Clone#childEnv()` の `#vaultCredentialOverlay` 経由）の両方へそのまま
 * 使われる。** ⟹ ここで固定した組み合わせは、両方の主体に同時に効く——
 * どちらかだけを直して片方を直し忘れる、という形が構造的に作れない。
 */
describe('resolveCredentialRows（正本と器の env から配る値を1本で決める）', () => {
  function row(name: string, value: string): StoredCredential {
    return { name, value, updatedAt: '2026-09-12T00:00:00.000Z' };
  }

  it('正本にしか無ければ、GitHub の名前でも正本が勝つ', () => {
    const resolved = resolveCredentialRows([row('GH_TOKEN', 'from-vault')], {});
    expect(resolved).toEqual([row('GH_TOKEN', 'from-vault')]);
  });

  it('器の env にしか無ければ、GitHub の名前は器の env から埋める（既存の土台）', () => {
    const resolved = resolveCredentialRows([], { GH_TOKEN: 'from-clone-env' });
    expect(resolved.map((r) => [r.name, r.value])).toEqual([['GH_TOKEN', 'from-clone-env']]);
  });

  it('両方に在って GitHub の名前なら、器の env が正本より勝つ', () => {
    const resolved = resolveCredentialRows([row('GH_TOKEN', 'from-vault')], {
      GH_TOKEN: 'from-clone-env',
    });
    expect(resolved).toEqual([{ name: 'GH_TOKEN', value: 'from-clone-env', updatedAt: expect.any(String) }]);
  });

  it('GITHUB_TOKEN でも同じ優先順位が効く（GH_TOKEN だけの特別扱いではない）', () => {
    const resolved = resolveCredentialRows([row('GITHUB_TOKEN', 'from-vault')], {
      GITHUB_TOKEN: 'from-clone-env',
    });
    expect(resolved.map((r) => [r.name, r.value])).toEqual([['GITHUB_TOKEN', 'from-clone-env']]);
  });

  it('🔴 器の env が空文字なら、GitHub の名前でも正本が勝つ（空は「置かれていない」と同じ）', () => {
    const resolved = resolveCredentialRows([row('GH_TOKEN', 'from-vault')], { GH_TOKEN: '' });
    expect(resolved).toEqual([row('GH_TOKEN', 'from-vault')]);
  });

  it('🔴 CLAUDE_CODE_OAUTH_TOKEN は対象外——両方に在っても正本が勝つ（プールの専用）', () => {
    // **正規の口（`apply()`）ではこの状態は作れない**（`assertEntries` が
    // `POOL_OWNED_CREDENTIAL_NAMES` を拒む）。それでも `resolveCredentialRows`
    // 自身が誤って解けないことを、入力を直接与えて測る——ここが唯一の門である。
    const resolved = resolveCredentialRows([row('CLAUDE_CODE_OAUTH_TOKEN', 'from-vault')], {
      CLAUDE_CODE_OAUTH_TOKEN: 'from-clone-env',
    });
    expect(resolved).toEqual([row('CLAUDE_CODE_OAUTH_TOKEN', 'from-vault')]);
  });

  it('🔴 ROTATABLE_CREDENTIAL_KEYS に無い任意の名前は対象外——両方に在っても正本が勝つ', () => {
    const resolved = resolveCredentialRows([row('NPM_TOKEN', 'from-vault')], {
      NPM_TOKEN: 'from-clone-env',
    });
    expect(resolved).toEqual([row('NPM_TOKEN', 'from-vault')]);
  });

  it('任意の名前は、正本にしか無くても配る（PR #825 の既存の約束を壊さない）', () => {
    const resolved = resolveCredentialRows([row('NPM_TOKEN', 'from-vault')], {});
    expect(resolved).toEqual([row('NPM_TOKEN', 'from-vault')]);
  });

  it('任意の名前は、器の env にしか無くても配らない（この土台は回せる名前だけに効く）', () => {
    const resolved = resolveCredentialRows([], { NPM_TOKEN: 'from-clone-env' });
    expect(resolved).toEqual([]);
  });

  /**
   * **⭐ 等価変異——ふるまいを変えない変更は生存してよい。**
   * `updatedAt` は「器の env が出所」であることを示す固定文字列で、配る
   * *値*（`value`）には関与しない。この文字列そのものを別の固定文字列へ
   * 差し替えても、`name` → `value` の対応（=このシステムがクローンと
   * マネージャーへ実際に渡すもの）は1文字も変わらない。
   */
  it('器の env 由来の行の updatedAt は固定文字列である（値には関与しない）', () => {
    const resolved = resolveCredentialRows([], { GH_TOKEN: 'from-clone-env' });
    expect(resolved[0]?.updatedAt).toBe('(クローンの器の環境変数)');
  });
});
