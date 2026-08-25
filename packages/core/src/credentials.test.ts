import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCredentialStore,
  credentialNamesShadowedByProfile,
  CREDENTIAL_NAME,
  fingerprintOf,
  isWithheldCredentialName,
  ROTATABLE_CREDENTIAL_KEYS,
} from './credentials.js';
import { WITHHELD_ENV_KEYS } from './runner.js';

/**
 * 鍵は器を作り直さずに回せること。
 *
 * ここで固定しているのは、実際に一晩溶かした失敗そのものである。人間は鍵を正しく
 * 差し替え、マネージャーは正しく 403 を報告し、**両方とも正しいまま噛み合わなかった**。
 * 原因は権限ではなく経路で、鍵が runner の起動時 env に凍っていた。
 */

let dir: string;

/** 置き場として使えないパス（途中がファイルなので mkdir が ENOTDIR で落ちる）。 */
function unusableDir(): string {
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  return join(blocker, 'credentials');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-cred-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

    // 新しいマネージャーへ配る値
    expect(store.values().GH_TOKEN).toBe('ghp_new');
    // **既に走っているマネージャーが読む器**。ここが変わることが本題である。
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
    // 値そのものは、どこにも現れない
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
    // 書けない置き場でも起動は止めない（env 経由の経路は残る）
    await expect(store.flush()).resolves.toBeDefined();
    expect(store.values().GH_TOKEN).toBe('ghp_x');
    // ただし黙って隠さない
    expect(store.lastWriteError).toBeDefined();
  });

  it('差し替えが器へ届かなければ、黙って成功にしない', async () => {
    const store = createCredentialStore({ dir: unusableDir(), seed: {}, names: ['GH_TOKEN'] });

    // 起動（flush）は器が無くても止めないが、**差し替え（set）は落ちたら知らせる**。
    // ここを握り潰すと「差し替えたのに直らない」という元の病気に戻る。
    await expect(store.set([{ name: 'GH_TOKEN', value: 'ghp_new' }])).rejects.toThrow();
    expect(store.lastWriteError).toBeDefined();
  });

  it('0400 の鍵を上書きできる（差し替えが黙って落ちない）', async () => {
    const store = createCredentialStore({ dir, seed: { GH_TOKEN: 'v1' }, names: ['GH_TOKEN'] });
    await store.flush();

    // 3回回しても、毎回ちゃんと入れ替わること
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

/**
 * 境界破りの回帰。
 *
 * どれも「鍵を回せるようにする」ために足した仕組みが、**先にあった守りを
 * 越えてしまっていた**もので、機能としては動いていた。動いていることは
 * 守れていることの証拠にならない。
 */
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

    // 置き場をファイルで塞いで、書き込みだけを失敗させる
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a directory');

    await expect(store.set([{ name: 'GH_TOKEN', value: 'v2' }])).rejects.toThrow();

    // **配る値も指紋も、器に入っている古い鍵のまま。** 片方だけ進むと、
    // 指紋（食い違いを見つけるために足したもの）自体が嘘をつく
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
    // 種が無くても所在は知らせる（後から置かれた鍵も同じ経路で届く）
    expect(env.ALTEROID_GITHUB_TOKEN_FILE).toBe(join(dir, 'GITHUB_TOKEN'));
  });
});

/**
 * バッチ更新の途中で失敗しても、**指紋が器の中身と食い違わない**こと。
 *
 * 複数ファイルにまたがる書き込みに原子性は無い。巻き戻しで取り繕おうとすると、
 * 「1件目は新値・memory は旧値」という食い違いが残り（巻き戻し自体も失敗しうる）、
 * 食い違いを見つけるために足した指紋そのものが嘘をつく。守るのは原子性の見かけ
 * ではなく、**指紋が常に器と一致している**という約束のほうである。
 */
describe('途中で失敗したバッチ', () => {
  /** その名前だけ rename を失敗させる（置き場所をディレクトリで塞ぐ）。 */
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

    // 1件目は器にもメモリにも入っている（＝食い違わない）
    expect(readFileSync(join(dir, 'GH_TOKEN'), 'utf8')).toBe('gh-new');
    expect(store.values().GH_TOKEN).toBe('gh-new');
    expect(store.fingerprints().find((f) => f.name === 'GH_TOKEN')?.sha256).toBe(
      fingerprintOf('gh-new'),
    );

    // 2件目は器にもメモリにも入っていない
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

    // 消えたものは器からもメモリからも消えている
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
});

/**
 * Claude の認証を回せる鍵にした（Issue #393 PR3）。**足したことで変わるのは
 * 2つだけである**——値が器のファイルになり、所在の env が1つ増える。
 */
describe('CLAUDE_CODE_OAUTH_TOKEN を回せる鍵にする', () => {
  it('回せる鍵の一覧に入っている', () => {
    expect(ROTATABLE_CREDENTIAL_KEYS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('伏せる鍵ではないので、名前の検査で落とされない', () => {
    // `WITHHELD_ENV_KEYS` に在る名前は種の時点で落ちる（伏せる仕組みを配る仕組みが
    // 越えないようにするため）。ここが落ちていたら、足しても静かに効かない。
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
    // **値は所在の env に出さない。**
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

/**
 * プロファイルが鍵を影にする形（Issue #393 PR3）。
 *
 * **`runner.ts` の `#childEnv()` はプロファイルを鍵より後に重ねる。** ⟹ プロファイルに
 * 同じ名前が在ると、回した鍵が黙って上書きされる。**しかもプロファイルはクローン
 * 自身が書けるので、クローンが自分でローテーションを無効化できる。**
 */
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
    // 1つで止めると、2つ目の影が黙って残る。
    expect(
      credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, [
        'GH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ]),
    ).toEqual(['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });
});
