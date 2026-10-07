import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  createCredentialStore,
  credentialNamesShadowedByProfile,
  CREDENTIAL_NAME,
  ENV_FILE_OWNED_CREDENTIAL_NAMES,
  fingerprintOf,
  isWithheldCredentialName,
  POOL_OWNED_CREDENTIAL_NAMES,
  ROTATABLE_CREDENTIAL_KEYS,
} from './credentials.js';
import { CLONE_PROVIDER_ENV_KEY, MANAGER_PROVIDER_ENV_KEY } from './agent-provider-selection.js';
import { CLONE_MODEL_ENV_KEY } from './clone.js';
import { MANAGER_MODEL_ENV_KEY, WITHHELD_ENV_KEYS, WORKER_MODEL_ENV_KEY } from './runner.js';

let dir: string;

function unusableDir(): string {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  return join(blocker, 'credentials');
}

beforeEach(() => {
  dir = makeTempDirSync('alteroid-cred-');
});

describe('鍵の器', () => {
  it('起動時の env から拾って器へ置く', async () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'ghp_old' },
      names: ['GH_TOKEN'],
    });
    await store.flush();

    expect(store.values()).toEqual({ GH_TOKEN: 'ghp_old' });
    expect(readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toBe('ghp_old');
  });

  it('差し替えると、配る値も器の中身も新しくなる（再起動なしで回る）', async () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'ghp_old' },
      names: ['GH_TOKEN'],
    });
    await store.flush();

    await store.set([{ name: 'GH_TOKEN', value: 'ghp_new' }]);

    expect(store.values().GH_TOKEN).toBe('ghp_new');
    expect(readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toBe('ghp_new');
  });

  it('空文字は「鍵を外す」— 器からも消える', async () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'ghp_old' },
      names: ['GH_TOKEN'],
    });
    await store.flush();

    await store.set([{ name: 'GH_TOKEN', value: '' }]);

    expect(store.values().GH_TOKEN).toBeUndefined();
    expect(() => readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toThrow();
  });

  it('空の env は「置かれていない」と同じに扱う（空の鍵を配らない）', () => {
    const store = createCredentialStore({ dir, seed: { GH_TOKEN: '' }, names: ['GH_TOKEN'] });
    expect(store.values()).toEqual({});
    expect(store.fingerprints()).toEqual([]);
  });

  it('指紋は値を出さずに同一性だけを見せる', async () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'ghp_secret_value' },
      names: ['GH_TOKEN'],
      now: () => new Date('2026-08-13T00:00:00.000Z'),
    });

    const [fingerprint] = store.fingerprints();

    expect(fingerprint?.name).toBe('GH_TOKEN');
    expect(fingerprint?.sha256).toBe(fingerprintOf('ghp_secret_value'));
    expect(fingerprint?.sha256).toHaveLength(12);
    expect(JSON.stringify(store.fingerprints())).not.toContain('ghp_secret_value');
  });

  it('器のファイルは所有者しか読めない（0400）', async () => {
    const store = createCredentialStore({ dir, seed: { GH_TOKEN: 'ghp_x' }, names: ['GH_TOKEN'] });
    await store.flush();

    expect(statSync(join(dir, 'GH_TOKEN')).mode & 0o777).toBe(0o400);
  });

  it('値に改行を足さない（cat した中身がそのまま鍵になる）', async () => {
    const store = createCredentialStore({ dir, seed: { GH_TOKEN: 'ghp_x' }, names: ['GH_TOKEN'] });
    await store.flush();

    expect(readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toBe('ghp_x');
  });

  it('器へ書けなくても値は配れる（経路が1本折れても能力を落とさない）', async () => {
    const store = createCredentialStore({
      dir: unusableDir(),
      seed: { GH_TOKEN: 'ghp_x' },
      names: ['GH_TOKEN'],
    });
    await expect(store.flush()).resolves.toBeDefined();
    expect(store.values().GH_TOKEN).toBe('ghp_x');
    expect(store.lastWriteError).toBeDefined();
  });

  it('差し替えが器へ届かなければ、黙って成功にしない', async () => {
    const store = createCredentialStore({ dir: unusableDir(), seed: {}, names: ['GH_TOKEN'] });

    await expect(store.set([{ name: 'GH_TOKEN', value: 'ghp_new' }])).rejects.toThrow();
    expect(store.lastWriteError).toBeDefined();
  });

  it('0400 の鍵を上書きできる（差し替えが黙って落ちない）', async () => {
    const store = createCredentialStore({ dir, seed: { GH_TOKEN: 'v1' }, names: ['GH_TOKEN'] });
    await store.flush();

    for (const value of ['v2', 'v3', 'v4']) {
      await store.set([{ name: 'GH_TOKEN', value }]);
      expect(readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toBe(value);
    }
    expect(store.lastWriteError).toBeUndefined();
  });

  it('子へ知らせるのは所在であって値ではない', () => {
    const store = createCredentialStore({ dir, seed: { GH_TOKEN: 'ghp_x' }, names: ['GH_TOKEN'] });

    const env = store.env();

    expect(env.ALTEROID_GH_TOKEN_FILE).toBe(join(dir, 'GH_TOKEN'));
    expect(JSON.stringify(env)).not.toContain('ghp_x');
  });
});

describe('鍵の器が越えてはいけない線', () => {
  it('器の外を指す名前を受け付けない（root で任意のパスに書けない）', async () => {
    const store = createCredentialStore({ dir, seed: {}, names: ['GH_TOKEN'] });

    for (const name of [
      '../../../etc/cron.d/x',
      '..',
      'a/b',
      '/etc/passwd',
      'GH_TOKEN/../../x',
      'gh_token',
    ]) {
      await expect(store.set([{ name, value: 'x' }])).rejects.toThrow();
    }
  });

  it('伏せる鍵を、鍵として配れない（消したものを注入し直せない）', async () => {
    const store = createCredentialStore({
      dir,
      seed: {},
      names: ['GH_TOKEN'],
      withheldEnvKeys: ['ALTEROID_DATABASE_URL', 'ALTEROID_RUNNER_TOKEN'],
    });

    await expect(
      store.set([{ name: 'ALTEROID_DATABASE_URL', value: 'postgres://stolen' }]),
    ).rejects.toThrow();
    expect(store.values().ALTEROID_DATABASE_URL).toBeUndefined();
  });

  it('器へ書けなかったら、memory も元に戻す（指紋が実ファイルと食い違わない）', async () => {
    const store = createCredentialStore({ dir, seed: { GH_TOKEN: 'v1' }, names: ['GH_TOKEN'] });
    await store.flush();

    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');

    await expect(store.set([{ name: 'GH_TOKEN', value: 'v2' }])).rejects.toThrow();

    expect(store.values().GH_TOKEN).toBe('v1');
    expect(store.fingerprints()[0]?.sha256).toBe(fingerprintOf('v1'));
  });

  it('扱う鍵ぜんぶの所在を子へ知らせる（回せない鍵を作らない）', () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'a' },
      names: ['GH_TOKEN', 'GITHUB_TOKEN'],
    });

    const env = store.env();

    expect(env.ALTEROID_GH_TOKEN_FILE).toBe(join(dir, 'GH_TOKEN'));
    expect(env.ALTEROID_GITHUB_TOKEN_FILE).toBe(join(dir, 'GITHUB_TOKEN'));
  });

  it('表に無い名前が降りてきても、その所在を子へ知らせる（配ったのに読み直せない鍵を作らない）', async () => {
    const store = createCredentialStore({ dir, seed: {}, names: ['GH_TOKEN'] });

    await store.set([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    const env = store.env();

    expect(env.ALTEROID_NPM_TOKEN_FILE).toBe(join(dir, 'NPM_TOKEN'));
    expect(env.ALTEROID_GH_TOKEN_FILE).toBe(join(dir, 'GH_TOKEN'));
    expect(JSON.stringify(env)).not.toContain('npm_x');
  });
});

describe('途中で失敗したバッチ', () => {
  function block(name: string): void {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'occupied'), 'x');
  }

  it('1件目が成功して2件目が失敗しても、指紋は器の中身と一致する', async () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'gh-old', GITHUB_TOKEN: 'github-old' },
      names: ['GH_TOKEN', 'GITHUB_TOKEN'],
    });
    await store.flush();
    rmSync(join(dir, 'GITHUB_TOKEN'));
    block('GITHUB_TOKEN');

    await expect(
      store.set([
        { name: 'GH_TOKEN', value: 'gh-new' },
        { name: 'GITHUB_TOKEN', value: 'github-new' },
      ]),
    ).rejects.toThrow(/GITHUB_TOKEN/);

    expect(readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toBe('gh-new');
    expect(store.values().GH_TOKEN).toBe('gh-new');
    expect(store.fingerprints().find((f) => f.name === 'GH_TOKEN')?.sha256).toBe(
      fingerprintOf('gh-new'),
    );

    expect(store.values().GITHUB_TOKEN).toBe('github-old');
    expect(store.fingerprints().find((f) => f.name === 'GITHUB_TOKEN')?.sha256).toBe(
      fingerprintOf('github-old'),
    );
  });

  it('削除が成功したあとに後続が失敗しても、削除は削除のまま残る', async () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'gh-old', GITHUB_TOKEN: 'github-old' },
      names: ['GH_TOKEN', 'GITHUB_TOKEN'],
    });
    await store.flush();
    rmSync(join(dir, 'GITHUB_TOKEN'));
    block('GITHUB_TOKEN');

    await expect(
      store.set([
        { name: 'GH_TOKEN', value: '' },
        { name: 'GITHUB_TOKEN', value: 'github-new' },
      ]),
    ).rejects.toThrow(/GITHUB_TOKEN/);

    expect(() => readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toThrow();
    expect(store.values().GH_TOKEN).toBeUndefined();
    expect(store.fingerprints().some((f) => f.name === 'GH_TOKEN')).toBe(false);
  });

  it('どこまで進んだかを例外が伝える（黙って途中で止まらない）', async () => {
    const store = createCredentialStore({
      dir,
      seed: { GH_TOKEN: 'gh-old' },
      names: ['GH_TOKEN', 'GITHUB_TOKEN'],
    });
    await store.flush();
    block('GITHUB_TOKEN');

    await expect(
      store.set([
        { name: 'GH_TOKEN', value: 'gh-new' },
        { name: 'GITHUB_TOKEN', value: 'github-new' },
      ]),
    ).rejects.toThrow(/適用済み: GH_TOKEN/);
  });

  it('大きなバッチが途中で止まっても、適用済み／未適用の列挙は抜粋の合図で締まる', async () => {
    const count = 120;
    const names = Array.from({ length: count }, (_, index) => `TOKEN_${index}`);
    const store = createCredentialStore({ dir, seed: {}, names });
    await store.flush();
    const blockedIndex = 60;
    block(names[blockedIndex]!);

    let caught: unknown;
    try {
      await store.set(names.map((name) => ({ name, value: `${name}-new` })));
    } catch (error) {
      caught = error;
    }
    const message = String((caught as Error | undefined)?.message);
    expect(message).toContain(names[blockedIndex]!);
    expect(message).toContain('適用済み');
    expect(message).toContain('未適用');
    expect(message.length).toBeLessThan(1_500);
    expect(message).toMatch(/省略/);
  });
});

describe('CLAUDE_CODE_OAUTH_TOKEN を回せる鍵にする', () => {
  it('回せる鍵の一覧に入っている', () => {
    expect(ROTATABLE_CREDENTIAL_KEYS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('伏せる鍵ではないので、名前の検査で落とされない', () => {
    expect(CREDENTIAL_NAME.test('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(isWithheldCredentialName('CLAUDE_CODE_OAUTH_TOKEN', WITHHELD_ENV_KEYS)).toBe(false);
  });

  it('器の env に在れば種として取り込み、値として子へ渡す', () => {
    const store = createCredentialStore({
      dir: '/tmp/does-not-matter',
      seed: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-seeded' },
    });
    expect(store.values().CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-seeded');
  });

  it('所在の env が増える（値ではない）', () => {
    const store = createCredentialStore({ dir: '/run/alteroid/credentials', seed: {} });
    const env = store.env();
    expect(env.ALTEROID_CLAUDE_CODE_OAUTH_TOKEN_FILE).toBe(
      '/run/alteroid/credentials/CLAUDE_CODE_OAUTH_TOKEN',
    );
    expect(JSON.stringify(env)).not.toContain('sk-ant-oat');
  });

  it('指紋には出るが、値そのものは出ない', () => {
    const store = createCredentialStore({
      dir: '/tmp/does-not-matter',
      seed: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-seeded' },
    });
    const fingerprints = store.fingerprints();
    expect(fingerprints.map((f) => f.name)).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(JSON.stringify(fingerprints)).not.toContain('sk-ant-oat-seeded');
  });
});

describe('ENV_FILE_OWNED_CREDENTIAL_NAMES（正本を器の生の環境変数が持つ名前）', () => {
  it('いまはこの一覧だけである（2群。推測で広がらない）', () => {
    expect([...ENV_FILE_OWNED_CREDENTIAL_NAMES].sort()).toEqual([
      'ALTEROID_ALLOWED_ORIGINS',
      'ALTEROID_AUTH',
      'ALTEROID_CLONE_MODEL',
      'ALTEROID_CLONE_PEERS',
      'ALTEROID_CLONE_PROVIDER',
      'ALTEROID_GOOGLE_CLIENT_ID',
      'ALTEROID_GOOGLE_CLIENT_SECRET',
      'ALTEROID_MANAGER_MODEL',
      'ALTEROID_MANAGER_PROVIDER',
      'ALTEROID_PUBLIC_URL',
      'ALTEROID_WORKER_MODEL',
    ]);
  });

  it('モデル帯の3つは、各層が実際に読む環境変数名と一致する', () => {
    for (const key of [CLONE_MODEL_ENV_KEY, MANAGER_MODEL_ENV_KEY, WORKER_MODEL_ENV_KEY]) {
      expect(ENV_FILE_OWNED_CREDENTIAL_NAMES).toContain(key);
    }
  });

  it('provider の2つは、各層が実際に読む環境変数名と一致する', () => {
    for (const key of [CLONE_PROVIDER_ENV_KEY, MANAGER_PROVIDER_ENV_KEY]) {
      expect(ENV_FILE_OWNED_CREDENTIAL_NAMES).toContain(key);
    }
  });

  it('ROTATABLE_CREDENTIAL_KEYS（回せる鍵）には1つも含まない', () => {
    for (const name of ENV_FILE_OWNED_CREDENTIAL_NAMES) {
      expect(ROTATABLE_CREDENTIAL_KEYS).not.toContain(name);
    }
  });
});

describe('credentialNamesShadowedByProfile', () => {
  it('プロファイルが同じ名前を宣言していたら、その名前を返す', () => {
    expect(
      credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, [
        'PATH',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]),
    ).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('影が無ければ空（無いことを「不明」にしない）', () => {
    expect(credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, ['PATH', 'EDITOR'])).toEqual(
      [],
    );
  });

  it('複数あれば全部返す（1つ見つけて打ち切らない）', () => {
    expect(
      credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, [
        'GH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]),
    ).toEqual(['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });
});

describe('CODEX_API_KEY を袋（回せる鍵）に入れる', () => {
  it('回せる鍵の一覧に入っている', () => {
    expect(ROTATABLE_CREDENTIAL_KEYS).toContain('CODEX_API_KEY');
  });

  it('プール・器の env が正本のどの一覧にも入らない（足した効果が袋だけに留まる）', () => {
    expect(POOL_OWNED_CREDENTIAL_NAMES).not.toContain('CODEX_API_KEY');
    expect(ENV_FILE_OWNED_CREDENTIAL_NAMES).not.toContain('CODEX_API_KEY');
  });

  it('伏せる鍵ではなく、名前の検査で落とされない', () => {
    expect(CREDENTIAL_NAME.test('CODEX_API_KEY')).toBe(true);
    expect(isWithheldCredentialName('CODEX_API_KEY', WITHHELD_ENV_KEYS)).toBe(false);
  });

  it('種として取り込み、値として子へ渡し、所在の env だけが増える', () => {
    const store = createCredentialStore({
      dir: '/run/alteroid/credentials',
      seed: { CODEX_API_KEY: 'fake-codex-key-0000000000' },
    });
    expect(store.values().CODEX_API_KEY).toBe('fake-codex-key-0000000000');
    const env = store.env();
    expect(env.ALTEROID_CODEX_API_KEY_FILE).toBe('/run/alteroid/credentials/CODEX_API_KEY');
    expect(JSON.stringify(env)).not.toContain('fake-codex-key');
  });

  it('指紋には出るが、値そのものは出ない', () => {
    const store = createCredentialStore({
      dir: '/tmp/does-not-matter',
      seed: { CODEX_API_KEY: 'fake-codex-key-0000000000' },
    });
    const fingerprints = store.fingerprints();
    expect(fingerprints.map((f) => f.name)).toContain('CODEX_API_KEY');
    expect(JSON.stringify(fingerprints)).not.toContain('fake-codex-key');
  });

  it('CODEX_HOME は袋に入れていない（決め打ちしない。auth.json の置き場は後の段）', () => {
    expect(ROTATABLE_CREDENTIAL_KEYS).not.toContain('CODEX_HOME');
  });
});
