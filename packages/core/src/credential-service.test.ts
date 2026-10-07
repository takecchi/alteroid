import { describe, expect, it, vi } from 'vitest';

import { createCredentialService, resolveCredentialRows } from './credential-service.js';
import {
  ENV_FILE_OWNED_CREDENTIAL_NAMES,
  fingerprintOf,
  type CredentialEntry,
} from './credentials.js';
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

function serviceOf(runners: RunnerClient[] = []) {
  const stores = createMemoryStores();
  const service = createCredentialService({
    stores,
    runners: registryOf(runners),
    withheldEnvKeys: [...WITHHELD],
  });
  return { stores, service };
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

  it('正本を器の生の環境変数が持つ名前は拒む（.env / Railway の変数が二重の正本を持たない）', async () => {
    const { stores, service } = serviceOf([fakeRunner()]);

    for (const name of ENV_FILE_OWNED_CREDENTIAL_NAMES) {
      await expect(service.apply([{ name, value: 'x' }])).rejects.toThrow();
    }
    expect(await stores.credentials.list()).toEqual([]);
  });

  it('層とモデル帯の3つも拒む（人間の承認の置き場を2つにしない）', async () => {
    // **群2**（`credentials.ts` の `ENV_FILE_OWNED_CREDENTIAL_NAMES` の doc）。
    // 置けてしまうと、クローンだけ効いて runner の2層は黙って効かない、という
    // 割れ方になる（読む主体が層ごとに違うため）。
    const { stores, service } = serviceOf([fakeRunner()]);

    for (const name of [
      'ALTEROID_CLONE_MODEL',
      'ALTEROID_MANAGER_MODEL',
      'ALTEROID_WORKER_MODEL',
    ]) {
      await expect(service.apply([{ name, value: 'opus' }])).rejects.toThrow();
    }
    expect(await stores.credentials.list()).toEqual([]);
  });

  /**
   * **⚠️ 2026-09-15 に期待を反転した。** 元の題は「正本を器の生の環境変数が持つ
   * 名前は、外す（空文字）操作でも拒む」で、元のコメントはこうだった:
   *
   * > **`POOL_OWNED_CREDENTIAL_NAMES` と同じ形——空文字も `entry.value` の
   * > 中身に関わらず assertEntries を通る前に落ちる。** すでに DB に紛れ込んで
   * > いる行を消したいだけの呼び出しも拒まれる、という既存の仕様をそのまま
   * > 引き継ぐことを固定する（新しい非対称を作らない）。
   *
   * **反転した理由——「同じ形」は消し口の有無を見ていなかった。**
   * `POOL_OWNED_CREDENTIAL_NAMES` には別の消し口が在る（`alteroid token remove`）
   * が、こちらには1つも無い。`PUT /credentials` が袋を触る唯一の口なので、
   * 空文字まで拒むと**一覧へ名前を足す前に置かれた行を人間が二度と消せない**。
   * この PR が一覧へ3つ足す以上、それは**この PR が作る穴**である。
   *
   * **保証は弱くなっていない。** 空文字は行を消す操作であり、「置ける」側へは
   * 1文字も倒れない（直上の2つの歯が、値を伴う書き込みを拒み続けることを測る）。
   */
  it('正本を器の生の環境変数が持つ名前でも、外す（空文字）操作は通る（消し口が他に無い）', async () => {
    const { stores, service } = serviceOf([fakeRunner()]);
    // 一覧へ名前を足す前に置かれた行を、店の側から直に作る（`apply` は拒むので）。
    await stores.credentials.put([
      { name: 'ALTEROID_CLONE_MODEL', value: 'opus', scope: 'app', secret: false },
    ]);

    await expect(
      service.apply([{ name: 'ALTEROID_CLONE_MODEL', value: '' }]),
    ).resolves.toBeDefined();

    expect(
      (await stores.credentials.list()).some((row) => row.name === 'ALTEROID_CLONE_MODEL'),
    ).toBe(false);
  });

  it('器の外を指す名前は拒む（正本はファイル名にもなる）', async () => {
    const { service } = serviceOf();

    for (const name of ['../../../etc/cron.d/x', 'a/b', 'gh_token', '']) {
      await expect(service.apply([{ name, value: 'x' }])).rejects.toThrow();
    }
  });

  /**
   * **runner の受け口（`runnerCredentialSchema.name`。`runner-protocol.ts`）と
   * 同じ128文字の上限をここでも課す**（横断レビュー C の14回目、#1790）。
   *
   * これが無いと、正本には書けるのに runner へは wire schema の上限で必ず
   * 弾かれる行が生まれる——`apply()` 自体は成功を返し、`pushAll` は runner
   * ごとの失敗を `{ ok: false }` として飲み込むだけなので、誰も気づけないまま
   * 「正本と runner がずっと食い違っている」状態が固定する。
   */
  it('runner の受け口と同じ128文字の上限を超える名前は拒む', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);
    // 形（英大文字・数字・_ のみ）は満たすが、長さだけが違反——長さの検査を
    // 単独で測るため、regex の違反と混ぜない。
    const tooLong = 'A'.repeat(129);

    await expect(
      service.apply([{ name: tooLong, value: 'fake-token-should-not-leak' }]),
    ).rejects.toThrow(/長すぎる/);

    // 何も書いていない（落ちるなら、何も書く前に落ちる）。
    expect(await stores.credentials.list()).toEqual([]);
    expect(runner.received).toEqual([]);
  });

  it('ちょうど128文字の名前は通る（上限は「以下」であって「未満」ではない）', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);
    const exactly128 = 'A'.repeat(128);

    await expect(
      service.apply([{ name: exactly128, value: 'fake-token-ok' }]),
    ).resolves.toBeDefined();

    expect((await stores.credentials.list()).map((row) => row.name)).toEqual([exactly128]);
    expect(runner.held.get(exactly128)).toBe('fake-token-ok');
  });

  it('上限超えのエラーは、名前そのものを1文字も含まない（際限なく伸びる名前をそのまま返さない）', async () => {
    const { service } = serviceOf();
    const tooLong = 'B'.repeat(500);

    try {
      await service.apply([{ name: tooLong, value: 'fake-x' }]);
      expect.unreachable('拒まれるはず');
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain(tooLong);
      expect(message).toContain('500');
      expect(message).toContain('128');
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
  /**
   * **⚠️ このテストは 2026-10-06 に期待値を再び反転した。** 上の 2026-09-11 の反転の
   * 経緯（元の題と本文）はそのまま残してある。
   *
   * 2026-09-11 の題: 「正本が空でも、クローンの器の env に在れば配る」——
   * `GH_TOKEN` / `GITHUB_TOKEN` / `CODEX_API_KEY` を、正本に行が無いときの最後の土台として
   * 器の env から配っていた。**その土台は撤去した**（2026-10-06 のオーナー決定「GH_TOKEN も
   * CODEX_API_KEY も普通の名前と同じ扱いにしてほしい」）。土台の「器の env」は実は起動時に
   * 正本から `process.env` へ書き写された値で、**正本から消しても配られ続けた**（実測
   * 2026-10-05）ためである。既存の器は、起動時に1度だけ正本へ移す
   * （`env-vars-boot.test.ts` の `migrateEnvBaseCredentialsOnce`）。
   *
   * **保証は弱くなっていない。** 守る対象が「器の env の鍵を配る」から「正本が唯一の出所である
   * （正本に無い名前は、プロセスの環境変数に何が在っても配らない）」へ移り、後者のほうが強い
   * （消した値が戻らない）。以前は `env` を引数で渡せたが、いまは出所が正本だけなので、
   * 実際の `process.env`（以前の既定）に鍵を置いて、**配られないこと**を測る。
   */
  it('正本が空なら、プロセスの環境変数に GH_TOKEN 等が在っても配らない（正本が唯一の出所）', async () => {
    vi.stubEnv('GH_TOKEN', 'ghp_from_clone_env');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_from_clone_env_2');
    vi.stubEnv('CODEX_API_KEY', 'sk-codex-from-env');
    try {
      const runner = fakeRunner();
      const { stores, service } = serviceOf([runner]);

      expect(await service.syncRunner(runner)).toBeNull();

      expect(runner.received).toEqual([]);
      expect(runner.held.size).toBe(0);
      expect(await stores.credentials.list()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('正本が空なら、1文字も配らない（「全部外せ」とは言わない）', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner]);

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
  /**
   * **⚠️ このテストは 2026-10-06 に期待値を再び反転した。** 上の 2026-09-12 の反転の経緯は
   * そのまま残してある。
   *
   * 2026-09-12 の題: 「GitHub の名前は、正本が在っても器の env のほうが勝つ」
   * （`GITHUB_CREDENTIAL_NAMES`）。**その特別扱いを撤去した**（2026-10-06 のオーナー決定
   * 「GH_TOKEN も通常の環境変数と同じように扱ってほしい」）。Issue #865 の実害
   * （マネージャーとクローンが別の鍵で走る）は、**器の env を出所から外す**ことで別の形で
   * 塞がる——両方の主体が同じ関数（`resolveCredentialRows`）を同じ正本の行で通すので、
   * 出所が正本1つしか無く、ずれようがない。
   *
   * **保証は弱くなっていない。** 守る対象が「GitHub の名前だけ、器の env を優先して揃える」から
   * 「どの名前も正本だけを見て揃える」へ広がった。そして実際に壊れていたのは、
   * 「器の env」が起動時に正本から書き写された古い値だったこと（正本を画面で更新しても古い値が
   * 配られた）——この歯が測るのはその反対（正本の値が必ず勝つ）である。
   */
  it('GitHub の名前も他の名前と同じく、正本が勝つ（プロセスの環境変数に別の値が在っても。2026-10-06）', async () => {
    vi.stubEnv('GH_TOKEN', 'ghp_from_clone_env');
    try {
      const runner = fakeRunner();
      const { service } = serviceOf([runner]);
      await service.apply([{ name: 'GH_TOKEN', value: 'ghp_from_vault' }]);
      runner.received.length = 0;

      await service.syncRunner(runner);

      expect(runner.held.get('GH_TOKEN')).toBe('ghp_from_vault');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('正本から GH_TOKEN を外せば、プロセスの環境変数に値が在っても runner から消える（書き写された古い値が蘇らない）', async () => {
    vi.stubEnv('GH_TOKEN', 'ghp_written_at_boot');
    try {
      const runner = fakeRunner();
      const { service } = serviceOf([runner]);
      await service.apply([{ name: 'GH_TOKEN', value: 'ghp_from_vault' }]);
      await service.apply([{ name: 'GH_TOKEN', value: '' }]);
      runner.received.length = 0;

      expect(await service.syncRunner(runner)).toBeNull();

      expect(runner.held.has('GH_TOKEN')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('GitHub 以外の任意の名前も、従来どおり正本が勝つ', async () => {
    vi.stubEnv('NPM_TOKEN', 'from_clone_env');
    try {
      const runner = fakeRunner();
      const { service } = serviceOf([runner]);
      await service.apply([{ name: 'NPM_TOKEN', value: 'from_vault' }]);
      runner.received.length = 0;

      await service.syncRunner(runner);

      expect(runner.held.get('NPM_TOKEN')).toBe('from_vault');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('プールが正本を持つ名前は、器の env に在っても配らない（撒き手を2つにしない）', async () => {
    // **回し手（`token-spread.ts`）が撒く名前である。** ここが同じ名前を降ろすと、
    // 名乗り直しのたびに回した鍵を巻き戻す。
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-from-env');
    try {
      const runner = fakeRunner();
      const { service } = serviceOf([runner]);

      expect(await service.syncRunner(runner)).toBeNull();
      expect(runner.received).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
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
 * **「器の env が正本に勝つ」ことの検出（`shadowsCloneEnv`・`onCloneEnvShadowed`。#865・#1894）は
 * 撤去した（2026-10-06）。**
 *
 * 検出していた状態（正本の行が、クローンの器の env の値に負けて配られない）は、勝つ側
 * （`GITHUB_CREDENTIAL_NAMES`）を撤去したので**起こり得ない**。この節にあった15本
 * （検出条件9本・勝敗の確認1本・第2引数5本）は、起こり得ない状態を測っていたので消した。
 * 3点セット（変更した事実・なぜ必要になったか・なぜ保証が弱くなっていないか）は PR 本文に
 * ある。**保証は「食い違いに気づける」から「食い違いが構造的に作れない」へ移った**ので、
 * その歯をここに置く: ①旗が決して立たない ②正本が必ず勝つ（上の `syncRunner` の節）。
 */
describe('器の env は出所ではない（旗も知らせも無い。2026-10-06）', () => {
  it('プロセスの環境変数に別の値が在っても、fingerprints() に shadowsCloneEnv は付かない', async () => {
    vi.stubEnv('GH_TOKEN', 'dummy-not-a-real-token-clone-env');
    try {
      const { service } = serviceOf([]);
      await service.apply([{ name: 'GH_TOKEN', value: 'dummy-not-a-real-token-vault' }]);

      const rows = await service.fingerprints();
      expect(rows).toEqual([expect.objectContaining({ name: 'GH_TOKEN' })]);
      expect(rows[0]).not.toHaveProperty('shadowsCloneEnv');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * **scope: 'runner' の GH_TOKEN の実測（issue #1894）。** 元の主張は2つだった:
 * (1) manager は器の env の値で走る (2) 正本の行を外しても manager へ配られる値は
 * 変わらない。
 *
 * **⚠️ 2026-10-06 に期待値を反転した**（元の題と本文はこの下の it のコメントに残す）。
 * GitHub の特別扱い（器の env が正本に勝つ）と、器の env を最後の土台にする経路を撤去したため、
 * 2つの主張はどちらも逆になった: (1) manager は**正本の値**で走る (2) 正本の行を外せば、
 * manager へ配られるものは**無くなる**。**保証は弱くなっていない**——元は「器の env が勝つ
 * こと」の確認で、いまは「正本が唯一の出所であること」の確認であり、後者は消した値が
 * 戻らないことまで言う（実測 2026-10-05 の不具合の反対側）。
 */
describe('scope: runner の GH_TOKEN の実測（issue #1894 → 2026-10-06 に反転）', () => {
  const VAULT = 'dummy-not-a-real-token-vault';

  const runnerRow: StoredCredential = {
    name: 'GH_TOKEN',
    value: VAULT,
    updatedAt: '2026-09-14T00:00:00.000Z',
    scope: 'runner',
  };

  it('(1) manager は正本の値で走る（scope: runner の GH_TOKEN）', () => {
    expect(resolveCredentialRows([runnerRow], 'manager')).toEqual([runnerRow]);
  });

  it('(2) 正本の行を外せば、manager へ配られる値は無くなる（scope: runner）', () => {
    expect(resolveCredentialRows([runnerRow], 'manager').map((row) => row.value)).toEqual([VAULT]);
    expect(resolveCredentialRows([], 'manager')).toEqual([]);
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
describe('resolveCredentialRows（正本から配る値を1本で決める）', () => {
  function row(name: string, value: string): StoredCredential {
    return { name, value, updatedAt: '2026-09-12T00:00:00.000Z' };
  }

  it('正本にしか無ければ、GitHub の名前でも正本が勝つ', () => {
    const resolved = resolveCredentialRows([row('GH_TOKEN', 'from-vault')], 'clone');
    expect(resolved).toEqual([row('GH_TOKEN', 'from-vault')]);
  });

  /**
   * **書き込みを拒むだけでは塞がらない**（2026-09-15）。`assertEntries` が
   * 拒むようになる前に置かれた行は袋に残り続け、配られれば
   * `applyAppScopedEnvVars` がデーモンの `process.env` を上書きする。
   */
  it('正本が器の生の環境変数である名前は、行が在っても配らない', () => {
    for (const name of ENV_FILE_OWNED_CREDENTIAL_NAMES) {
      expect(resolveCredentialRows([row(name, 'from-vault')], 'clone')).toEqual([]);
      expect(resolveCredentialRows([row(name, 'from-vault')], 'manager')).toEqual([]);
    }
  });

  it('落とすのはその名前だけで、隣の行は配る', () => {
    const resolved = resolveCredentialRows(
      [row('ALTEROID_MANAGER_MODEL', 'sonnet'), row('GH_TOKEN', 'from-vault')],
      'manager',
    );
    expect(resolved).toEqual([row('GH_TOKEN', 'from-vault')]);
  });

  /**
   * **⚠️ 2026-10-06 に、この区間の6本の期待値を反転・削除した。** 元の題（反転前）:
   * 「器の env にしか無ければ、GitHub の名前は器の env から埋める（既存の土台）」/
   * 「両方に在って GitHub の名前なら、器の env が正本より勝つ」/「GITHUB_TOKEN でも同じ優先順位が
   * 効く」/「🔴 器の env が空文字なら、GitHub の名前でも正本が勝つ」/「🔴 CLAUDE_CODE_OAUTH_TOKEN
   * は対象外——両方に在っても正本が勝つ」/「🔴 ROTATABLE_CREDENTIAL_KEYS に無い任意の名前は対象外」
   * /「任意の名前は、器の env にしか無くても配らない」/「器の env 由来の行の updatedAt は固定文字列」。
   *
   * **`resolveCredentialRows` は器の env を引数に取らなくなった**（オーナー決定 2026-10-06
   * 「GH_TOKEN も CODEX_API_KEY も普通の名前と同じ扱い」）。⟹ 「器の env が勝つ」「器の env から
   * 埋める」を測る入力がそもそも無い。**保証は強くなっている**: 以前は「器の env は GitHub の名前
   * だけ勝つ・回せる名前だけ土台になる」という**名前ごとの場合分け**を歯が守っていたが、いまは
   * 「出力は正本の行（scope と除外名で絞ったもの）に限る」という1本の主張に畳まれ、下の歯がそれを
   * 守る。プールの名前・任意の名前が正本のまま勝つこと（元の 🔴 の2本）は、正本の行だけを返すことで
   * 構造的に満たされ、下の「出力は入力の行の部分集合」が測る。
   */
  it('GitHub の名前も、正本の行が在ればそのまま配る（特別扱いは無い）', () => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'CODEX_API_KEY']) {
      expect(resolveCredentialRows([row(name, 'from-vault')], 'clone')).toEqual([
        row(name, 'from-vault'),
      ]);
    }
  });

  it('正本が空なら、何も出ない（土台は無い）', () => {
    expect(resolveCredentialRows([], 'clone')).toEqual([]);
    expect(resolveCredentialRows([], 'manager')).toEqual([]);
  });

  it('出力は入力の行の部分集合である（行を作り出さない・値を差し替えない）', () => {
    const rows = [
      row('GH_TOKEN', 'a'),
      row('NPM_TOKEN', 'b'),
      row('CLAUDE_CODE_OAUTH_TOKEN', 'c'),
      row('CODEX_API_KEY', 'd'),
    ];
    const resolved = resolveCredentialRows(rows, 'clone');
    for (const out of resolved) expect(rows).toContainEqual(out);
  });

  it('target を変えても、scope の無い行（＝ all 相当）は両方に届く', () => {
    const rows: StoredCredential[] = [
      { name: 'NPM_TOKEN', value: 'npm_x', updatedAt: '2026-09-14T00:00:00.000Z' },
    ];
    expect(resolveCredentialRows(rows, 'clone')).toEqual(rows);
    expect(resolveCredentialRows(rows, 'manager')).toEqual(rows);
  });

  it('scope: app の行は clone にだけ届き、manager には届かない', () => {
    const rows: StoredCredential[] = [
      { name: 'TZ', value: 'Asia/Tokyo', updatedAt: '2026-09-14T00:00:00.000Z', scope: 'app' },
    ];
    expect(resolveCredentialRows(rows, 'clone')).toEqual(rows);
    expect(resolveCredentialRows(rows, 'manager')).toEqual([]);
  });

  it('scope: runner の行は manager にだけ届き、clone には届かない', () => {
    const rows: StoredCredential[] = [
      {
        name: 'MANAGER_ONLY',
        value: 'x',
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'runner',
      },
    ];
    expect(resolveCredentialRows(rows, 'clone')).toEqual([]);
    expect(resolveCredentialRows(rows, 'manager')).toEqual(rows);
  });

  it('scope: all を明示した行も、scope が無い行と同じく両方に届く', () => {
    const rows: StoredCredential[] = [
      { name: 'NPM_TOKEN', value: 'npm_x', updatedAt: '2026-09-14T00:00:00.000Z', scope: 'all' },
    ];
    expect(resolveCredentialRows(rows, 'clone')).toEqual(rows);
    expect(resolveCredentialRows(rows, 'manager')).toEqual(rows);
  });

  /**
   * **scope で宛先から外れた行は、manager へ配らない（issue #1867）。**
   *
   * 元の歯は「`scope: 'app'` の GH_TOKEN を、器の env の値で埋め戻して manager へ配ってしまう」
   * 不具合を測っていた（器の env を土台にする経路が在ったため）。**2026-10-06 にその経路を
   * 撤去したので、埋め戻す先がそもそも無い**——歯は「scope: 'app' の行は manager へ出ない」へ
   * 畳んだ（元の期待値 `[]` は同じ。入力から器の env を外した）。元のコメントの経緯: この歯は、
   * 層ごとのバグ探しの作業者が main の上で赤を取った再現（枝 `test/hunt-vault` の `b8eef89`）
   * を、直した後の保証の形に書き換えたもの。
   */
  it('scope: app の GH_TOKEN は manager へ配らない（issue #1867）', () => {
    const rows: StoredCredential[] = [
      {
        name: 'GH_TOKEN',
        value: 'ghp_FAKE_VAULT_VALUE',
        updatedAt: '2026-09-14T00:00:00.000Z',
        scope: 'app',
      },
    ];
    expect(resolveCredentialRows(rows, 'manager')).toEqual([]);
  });

  it('対照: scope: app の行を外した後も、manager へ配られるものは無い（器の env が埋め戻さない）', () => {
    expect(resolveCredentialRows([], 'manager')).toEqual([]);
  });
});

/**
 * **scope（撒く先）**。`packages/storage-pg/src/schema.ts` が `manager_credentials` /
 * `env_profile` について明記していた「行ごとに層への効かせ分けを持たせない」
 * という方針を、人間の明示的な指示で上書きした部分（2026-09-14）。ここでは
 * `apply()` → `runner.setCredentials()` の実配布経路まで通して確かめる
 * （上の `resolveCredentialRows` の describe は関数単体の確認）。
 */
describe('apply() の scope フィルタ（runner への実配布）', () => {
  it('既定（scope 省略）は runner へも降りる', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner]);
    await service.apply([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    expect(runner.held.get('NPM_TOKEN')).toBe('npm_x');
  });

  it('scope: app の行は runner へ降りない（clone だけに意味を持つ値だから）', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);
    await service.apply([{ name: 'TZ', value: 'Asia/Tokyo', scope: 'app', secret: false }]);
    expect(runner.held.has('TZ')).toBe(false);
    // 正本には在る（clone 自身の childEnv には届く——そちらは resolveCredentialRows
    // の describe が別途確かめている）。
    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'TZ', value: 'Asia/Tokyo', scope: 'app' }),
    ]);
  });

  it('scope: runner の行は降りる', async () => {
    const runner = fakeRunner();
    const { service } = serviceOf([runner]);
    await service.apply([{ name: 'MANAGER_ONLY', value: 'x', scope: 'runner' }]);
    expect(runner.held.get('MANAGER_ONLY')).toBe('x');
  });
});

describe('secret（値を API/CLI/Web UI に返すかどうか）', () => {
  it('既定は secret: true で、fingerprints() は値を1文字も返さない', async () => {
    const { service } = serviceOf([]);
    await service.apply([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    const rows = await service.fingerprints();
    expect(rows).toEqual([expect.objectContaining({ name: 'NPM_TOKEN', secret: true })]);
    expect(rows[0]).not.toHaveProperty('value');
    expect(JSON.stringify(rows)).not.toContain('npm_x');
  });

  it('secret: false の行は fingerprints() が値も返す', async () => {
    const { service } = serviceOf([]);
    await service.apply([{ name: 'TZ', value: 'Asia/Tokyo', secret: false }]);
    const rows = await service.fingerprints();
    expect(rows).toEqual([
      expect.objectContaining({ name: 'TZ', value: 'Asia/Tokyo', secret: false }),
    ]);
  });

  it('secret は作成時に決まり、既存行と異なる値を渡すと拒む（後から変更できない）', async () => {
    const { service } = serviceOf([]);
    await service.apply([{ name: 'TZ', value: 'Asia/Tokyo', secret: false }]);

    await expect(
      service.apply([{ name: 'TZ', value: 'Europe/London', secret: true }]),
    ).rejects.toThrow(/secret/);

    // 拒否は書く前に起きるので、値も secret も変わっていない。
    const rows = await service.fingerprints();
    expect(rows).toEqual([
      expect.objectContaining({ name: 'TZ', value: 'Asia/Tokyo', secret: false }),
    ]);
  });

  it('secret を省略すれば、既存行の secret を引き継いだまま値だけ更新できる', async () => {
    const { service } = serviceOf([]);
    await service.apply([{ name: 'TZ', value: 'Asia/Tokyo', secret: false }]);
    await service.apply([{ name: 'TZ', value: 'Europe/London' }]);

    const rows = await service.fingerprints();
    expect(rows).toEqual([
      expect.objectContaining({ name: 'TZ', value: 'Europe/London', secret: false }),
    ]);
  });

  it('外して同じ名前を作り直すのは新規作成であり、secret を変えられる', async () => {
    const { service } = serviceOf([]);
    await service.apply([{ name: 'TZ', value: 'Asia/Tokyo', secret: false }]);
    await service.apply([{ name: 'TZ', value: '' }]); // 外す
    await service.apply([{ name: 'TZ', value: 'Europe/London', secret: true }]); // 作り直す

    const rows = await service.fingerprints();
    expect(rows).toEqual([expect.objectContaining({ name: 'TZ', secret: true })]);
    expect(rows[0]).not.toHaveProperty('value');
  });
});

describe('名前が長すぎる既存の行（#2445）', () => {
  const LONG_NAME = `LONG_${'A'.repeat(130)}`;

  it('空文字で消せる（長さの検査が外す操作まで拒まない）', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);
    await stores.credentials.put([{ name: LONG_NAME, value: 'old' }]);

    await expect(service.apply([{ name: LONG_NAME, value: '' }])).resolves.toBeDefined();
    expect(await stores.credentials.list()).toEqual([]);
    // runner の受け口は上限超えの名前を配列ごと弾くので、外す合図にも載せない
    expect(runner.received.flat().some((entry) => entry.name === LONG_NAME)).toBe(false);
  });

  it('空でない値で置くのは、これまでどおり拒む', async () => {
    const { stores, service } = serviceOf([fakeRunner()]);

    await expect(service.apply([{ name: LONG_NAME, value: 'x' }])).rejects.toThrow(/長すぎる/);
    expect(await stores.credentials.list()).toEqual([]);
  });

  it('正本に居ても配らず、ほかの鍵は配る。落としたことは stderr に名前の頭と長さで残る', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const runner = fakeRunner();
      const { stores, service } = serviceOf([runner]);
      await stores.credentials.put([
        { name: LONG_NAME, value: 'old' },
        { name: 'NPM_TOKEN', value: 'npm_x' },
      ]);

      await service.syncRunner(runner);
      expect(runner.held.get('NPM_TOKEN')).toBe('npm_x');
      expect(runner.held.has(LONG_NAME)).toBe(false);

      await service.apply([{ name: 'GIT_AUTHOR_NAME', value: 'takecchi' }]);
      expect(runner.held.get('GIT_AUTHOR_NAME')).toBe('takecchi');
      expect(runner.received.flat().some((entry) => entry.name === LONG_NAME)).toBe(false);

      const out = write.mock.calls.map((call) => String(call[0])).join('');
      expect(out).toContain('LONG_AAAA');
      expect(out).toContain(String(LONG_NAME.length));
      expect(out).not.toContain(LONG_NAME);
      expect(out).not.toContain('old');
    } finally {
      write.mockRestore();
    }
  });

  it('resolveCredentialRows は長い名前の行を落とす', () => {
    const rows: StoredCredential[] = [
      { name: LONG_NAME, value: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
      { name: 'NPM_TOKEN', value: 'npm_x', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(resolveCredentialRows(rows, 'manager').map((row) => row.name)).toEqual(['NPM_TOKEN']);
  });
});

/**
 * **更新が成功してクローンから見える値が変わったら知らせる（`onApplied`。2026-10-06 の
 * オーナー決定「環境変数を即時反映にしてほしい」）。** 呼び手（デーモン）はここで
 * クローンのセッションをターンの境界で畳んで resume させる。
 *
 * 測るのは「いつ鳴るか」——**増えた・値が変わった・消えた（削除）のどれでも鳴り、同じ値の
 * 書き直しと、クローンへ届かない行（scope: runner）では鳴らない。** 渡るのは名前だけである。
 */
describe('apply() が onApplied でクローンへ知らせる', () => {
  function serviceWithListener() {
    const stores = createMemoryStores();
    const calls: (readonly string[])[] = [];
    const service = createCredentialService({
      stores,
      runners: registryOf([]),
      withheldEnvKeys: [...WITHHELD],
      onApplied: (names) => {
        calls.push([...names]);
      },
    });
    return { stores, service, calls };
  }

  it('新しい名前を置いたら鳴る（名前だけ。値は渡らない）', async () => {
    const { service, calls } = serviceWithListener();
    await service.apply([{ name: 'GH_TOKEN', value: 'ghp_secret_value_1' }]);
    expect(calls).toEqual([['GH_TOKEN']]);
    expect(JSON.stringify(calls)).not.toContain('ghp_secret_value_1');
  });

  it('値を更新したら鳴る', async () => {
    const { service, calls } = serviceWithListener();
    await service.apply([{ name: 'GH_TOKEN', value: 'old' }]);
    calls.length = 0;
    await service.apply([{ name: 'GH_TOKEN', value: 'new' }]);
    expect(calls).toEqual([['GH_TOKEN']]);
  });

  it('削除（空値）も変更として鳴る', async () => {
    const { service, calls } = serviceWithListener();
    await service.apply([{ name: 'GH_TOKEN', value: 'old' }]);
    calls.length = 0;
    await service.apply([{ name: 'GH_TOKEN', value: '' }]);
    expect(calls).toEqual([['GH_TOKEN']]);
  });

  it('同じ値の書き直しでは鳴らない（畳み直しを無駄に起こさない）', async () => {
    const { service, calls } = serviceWithListener();
    await service.apply([{ name: 'GH_TOKEN', value: 'same' }]);
    calls.length = 0;
    await service.apply([{ name: 'GH_TOKEN', value: 'same' }]);
    expect(calls).toEqual([]);
  });

  it('クローンへ届かない行（scope: runner）を置いても鳴らない', async () => {
    const { service, calls } = serviceWithListener();
    await service.apply([{ name: 'MANAGER_ONLY', value: 'x', scope: 'runner' }]);
    expect(calls).toEqual([]);
  });

  it('scope を all から runner へ変えると、クローンから消えるので鳴る', async () => {
    const { service, calls } = serviceWithListener();
    await service.apply([{ name: 'NPM_TOKEN', value: 'x' }]);
    calls.length = 0;
    await service.apply([{ name: 'NPM_TOKEN', value: 'x', scope: 'runner' }]);
    expect(calls).toEqual([['NPM_TOKEN']]);
  });

  it('購読者が投げても、更新そのものは成功を返す', async () => {
    const stores = createMemoryStores();
    const service = createCredentialService({
      stores,
      runners: registryOf([]),
      withheldEnvKeys: [...WITHHELD],
      onApplied: () => {
        throw new Error('畳み直しの印を立てられなかった');
      },
    });
    await expect(service.apply([{ name: 'GH_TOKEN', value: 'x' }])).resolves.toBeDefined();
    expect(await stores.credentials.list()).toHaveLength(1);
  });
});
