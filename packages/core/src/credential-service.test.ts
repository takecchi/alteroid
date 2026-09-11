import { describe, expect, it } from 'vitest';

import { createCredentialService } from './credential-service.js';
import { fingerprintOf, type CredentialEntry } from './credentials.js';
import type { RunnerClient, RunnerCredentialFingerprint } from './runner-protocol.js';
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
  it('正本が空なら1文字も配らない（器の環境変数から拾った鍵を消して回らない）', async () => {
    const runner = fakeRunner();
    // 器の環境変数（`x-shared-env`）から種を拾った状態
    runner.held.set('GH_TOKEN', 'ghp_from_env');
    const { service } = serviceOf([runner]);

    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toEqual([]);
    expect(runner.held.get('GH_TOKEN')).toBe('ghp_from_env');
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
