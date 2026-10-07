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

const WITHHELD = ['ALTEROID_DATABASE_URL', 'ALTEROID_RUNNER_TOKEN'] as const;

function fakeRunner(runnerId = 'runner-test') {
  const received: CredentialEntry[][] = [];
  const held = new Map<string, string>();
  // credentials() を経由しない: 通すと、読みだけ落としたい回で書きまで落ちて偽物が本物と違う壊れ方をするため
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

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'GIT_AUTHOR_NAME', value: 'takecchi' }),
      expect.objectContaining({ name: 'NPM_TOKEN', value: 'npm_x' }),
    ]);
    expect(runner.held.get('GIT_AUTHOR_NAME')).toBe('takecchi');
    expect(runner.held.get('NPM_TOKEN')).toBe('npm_x');
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

  it('層ごとの provider の2つも拒む（袋に置けると層で割れる。#486 段 S1）', async () => {
    const { stores, service } = serviceOf([fakeRunner()]);

    for (const name of ['ALTEROID_CLONE_PROVIDER', 'ALTEROID_MANAGER_PROVIDER']) {
      await expect(service.apply([{ name, value: 'claude' }])).rejects.toThrow();
    }
    expect(await stores.credentials.list()).toEqual([]);
  });

  it('層とモデル帯の3つも拒む（人間の承認の置き場を2つにしない）', async () => {
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

  it('正本を器の生の環境変数が持つ名前でも、外す（空文字）操作は通る（消し口が他に無い）', async () => {
    const { stores, service } = serviceOf([fakeRunner()]);
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

  it('runner の受け口と同じ128文字の上限を超える名前は拒む', async () => {
    const runner = fakeRunner();
    const { stores, service } = serviceOf([runner]);
    const tooLong = 'A'.repeat(129);

    await expect(
      service.apply([{ name: tooLong, value: 'fake-token-should-not-leak' }]),
    ).rejects.toThrow(/長すぎる/);

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
  // 最終状態だけを見ない: 直列化していない実装でもたまたま揃って通るため、重なりそのものを数える
  it('層ごとに違う値が残らない（正本と runner が同じ値で揃う）', async () => {
    const runner = fakeRunner();
    const stores = createMemoryStores();

    const violations: string[] = [];
    let busy = false;

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
    const stored = (await stores.credentials.list()).find((row) => row.name === 'WHICH');
    expect(stored?.value).toBe(runner.held.get('WHICH'));
  });
});

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

describe('resolveCredentialRows（正本から配る値を1本で決める）', () => {
  function row(name: string, value: string): StoredCredential {
    return { name, value, updatedAt: '2026-09-12T00:00:00.000Z' };
  }

  it('正本にしか無ければ、GitHub の名前でも正本が勝つ', () => {
    const resolved = resolveCredentialRows([row('GH_TOKEN', 'from-vault')], 'clone');
    expect(resolved).toEqual([row('GH_TOKEN', 'from-vault')]);
  });

  it('正本が器の生の環境変数である名前は、行が在っても配らない', () => {
    for (const name of ENV_FILE_OWNED_CREDENTIAL_NAMES) {
      expect(resolveCredentialRows([row(name, 'from-vault')], 'clone')).toEqual([]);
      expect(resolveCredentialRows([row(name, 'from-vault')], 'manager')).toEqual([]);
    }
  });

  it('provider の2つも、行が在っても配らない', () => {
    for (const name of ['ALTEROID_CLONE_PROVIDER', 'ALTEROID_MANAGER_PROVIDER']) {
      expect(resolveCredentialRows([row(name, 'claude')], 'clone')).toEqual([]);
      expect(resolveCredentialRows([row(name, 'claude')], 'manager')).toEqual([]);
    }
  });

  it('落とすのはその名前だけで、隣の行は配る', () => {
    const resolved = resolveCredentialRows(
      [row('ALTEROID_MANAGER_MODEL', 'sonnet'), row('GH_TOKEN', 'from-vault')],
      'manager',
    );
    expect(resolved).toEqual([row('GH_TOKEN', 'from-vault')]);
  });

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
    await service.apply([{ name: 'TZ', value: '' }]);
    await service.apply([{ name: 'TZ', value: 'Europe/London', secret: true }]);
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
