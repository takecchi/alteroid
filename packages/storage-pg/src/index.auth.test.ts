import { createAuthProviderRegistry, createAuthService, decodeState } from '@alteroid/core';
import type { OAuthProfile, OAuthProvider } from '@alteroid/core';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import {
  createPgStoresFromDb,
  describePgConnectionError,
  migrate,
  type PgStores,
} from './index.js';
import { AUTH_ACCOUNTS_EMAIL_LOWER_INDEX } from './migrate.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * pg ドライバの受け入れ確認。
 *
 * **偽物の DB では確かめたことにならない。** PGlite はインプロセスで動く実
 * PostgreSQL なので、SQL・索引・冪等性まで本番と同じ経路で通る（CI に外部 DB を
 * 要求せずに済む）。fs ドライバのテストと同じ振る舞いを、同じ IF に対して問う。
 *
 * **このファイルは `index.test.ts` から移した（分割元は git blame で辿れる）。**
 * 元の1本（5588行・262テスト）は単独で走らせると 564.75s かかり、作業者の
 * Bash の既定タイムアウト（300s）に収まらなかった（2026-09-29 実測、
 * `.claude/skills/test-in-chunks/SKILL.md`）。`vitest --shard` はファイル数で
 * 等分するので、1本のままでは分割にならない——だから最上位の `describe`
 * 単位でファイルを分けた。ここは `AuthStore`（ログインとアクセス許可）と
 * `describePgConnectionError` を持つ。**`describe` / `it` の本文・順序は
 * 1文字も変えていない**——元ファイルの対応する範囲とこのファイルを突き合わせ
 * れば同一であることが確認できる。冒頭の足場（`beforeEach` で PGlite を
 * 都度立てて `migrate` する形、`afterEach` で閉じる形）も元ファイルと同じもの
 * を複製している（分岐は生まない——共有モジュールへ切り出すほどの複雑さが
 * 無かったため、各ファイルへ同じ短い足場を複製する側を選んだ）。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedPglite());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

/**
 * ログインとアクセス許可。**fs と pg で同じ振る舞いになること**を両方で問う
 * （器が違うだけで上の層が見るものは同じ、が M4 の要件）。
 */
describe('AuthStore', () => {
  const account = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: null,
    grantedBy: null,
    ownerDeclaredAt: null,
  };

  it('アカウントを保存して読み戻せる', async () => {
    await stores.auth.putAccount(account);

    expect(await stores.auth.getAccount('account-1')).toEqual(account);
    expect(await stores.auth.listAccounts()).toEqual([account]);
    expect(await stores.auth.getAccount('居ない')).toBeNull();
  });

  /**
   * **issue #1676。** fs / memory（`packages/storage-fs/src/index.test.ts` /
   * `packages/core/src/auth-service.test.ts` の同名の歯）は直す前、文字列比較の
   * `localeCompare` で並べていたためここで赤くなっていた。pg は
   * `timestamptz` 列（`asc(authAccounts.createdAt)`）で実時刻を比べるので、
   * オフセット表記が違っても崩れない——直した後は3実装とも同じ期待値で緑になる。
   */
  it('listAccounts は createdAt の実時刻順（timestamptz 列で比較するのでオフセット表記が違っても崩れない）', async () => {
    const early = {
      ...account,
      id: 'account-early-utc',
      email: 'early@example.test',
      createdAt: '2024-01-01T23:00:00+09:00', // 実時刻 2024-01-01T14:00:00Z
    };
    const late = {
      ...account,
      id: 'account-late-utc',
      email: 'late@example.test',
      createdAt: '2024-01-01T15:00:00+00:00', // 実時刻 2024-01-01T15:00:00Z
    };
    await stores.auth.putAccount(early);
    await stores.auth.putAccount(late);

    const ids = (await stores.auth.listAccounts()).map((it) => it.id);
    expect(ids).toEqual(['account-early-utc', 'account-late-utc']);
  });

  /**
   * **issue #1676（同じ族）。** fs / memory 側の同名の歯（`packages/storage-fs/
   * src/index.test.ts` / `packages/core/src/auth-service.test.ts`）と同じ入力・
   * 同じ期待値。pg は `createdAt` の `asc()` で並べる（更新しても順が動かない）。
   */
  it('listIdentities は createdAt の実時刻順で返す', async () => {
    await stores.auth.putAccount(account);
    const first = {
      provider: 'google',
      subject: 'sub-first',
      accountId: 'account-1',
      email: 'first@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    const second = {
      provider: 'google',
      subject: 'sub-second',
      accountId: 'account-1',
      email: 'second@example.test',
      emailVerified: true,
      createdAt: '2026-01-02T00:00:00.000Z',
      lastLoginAt: '2026-01-02T00:00:00.000Z',
    };
    await stores.auth.putIdentity(second);
    await stores.auth.putIdentity(first);

    const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
    expect(subjects).toEqual(['sub-first', 'sub-second']);
  });

  /**
   * **issue #1676（同じ族）。** fs / memory 側の同名の歯と同じ入力・同じ期待値。
   */
  it('listAccessTokens は createdAt の実時刻順で返す', async () => {
    await stores.auth.putAccount(account);
    const first = {
      id: 'token-first',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'first',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    const second = {
      id: 'token-second',
      accountId: 'account-1',
      sha256: 'b'.repeat(64),
      label: 'second',
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await stores.auth.putAccessToken(second);
    await stores.auth.putAccessToken(first);

    const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
    expect(ids).toEqual(['token-first', 'token-second']);
  });

  /**
   * **issue #1688（#1676 / PR #1681 の残り）。** `createdAt` が完全に同じ
   * （同着）行どうしの並びは、直上の歯だけでは揃わない。pg は2次キーの無い
   * `ORDER BY` では同着の行どうしの順を保証しない——`id` /
   * `(provider, subject)` という明示的な2次キーを `orderBy` に足した
   * （fs / memory と同じ形。`packages/storage-fs/src/index.test.ts` の
   * 同名の describe を見よ）。
   */
  describe('同着（createdAt が同一）の並び（issue #1688）', () => {
    const TIE = '2026-01-05T00:00:00.000Z';

    it('listAccounts: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
      const first = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
      const second = { ...account, id: 'account-b', email: 'b@example.test', createdAt: TIE };
      await stores.auth.putAccount(first);
      await stores.auth.putAccount(second);
      await stores.auth.putAccount({ ...first, displayName: 'Owner (renamed)' });

      const ids = (await stores.auth.listAccounts()).map((it) => it.id);
      expect(ids).toEqual(['account-a', 'account-b']);
    });

    it('listAccounts: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
      const first = { ...account, id: 'account-z', email: 'z@example.test', createdAt: TIE };
      const second = { ...account, id: 'account-a', email: 'a@example.test', createdAt: TIE };
      // 挿入順は z → a（id の昇順とは逆）。更新はしない。
      await stores.auth.putAccount(first);
      await stores.auth.putAccount(second);

      const ids = (await stores.auth.listAccounts()).map((it) => it.id);
      expect(ids).toEqual(['account-a', 'account-z']);
    });

    it('listIdentities: 同着の2行のうち先に作ったほうだけ後から更新すると、(provider, subject) 昇順のまま動かない', async () => {
      await stores.auth.putAccount(account);
      const first = {
        provider: 'google',
        subject: 'sub-first',
        accountId: 'account-1',
        email: 'first@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      const second = {
        provider: 'google',
        subject: 'sub-second',
        accountId: 'account-1',
        email: 'second@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      await stores.auth.putIdentity(first);
      await stores.auth.putIdentity(second);
      await stores.auth.putIdentity({ ...first, lastLoginAt: '2026-01-06T00:00:00.000Z' });

      const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
      expect(subjects).toEqual(['sub-first', 'sub-second']);
    });

    it('listIdentities: 同着2行を2次キー（subject）と逆順に挿入しても、subject 昇順で返る', async () => {
      await stores.auth.putAccount(account);
      const first = {
        provider: 'google',
        subject: 'sub-z',
        accountId: 'account-1',
        email: 'z@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      const second = {
        provider: 'google',
        subject: 'sub-a',
        accountId: 'account-1',
        email: 'a@example.test',
        emailVerified: true,
        createdAt: TIE,
        lastLoginAt: TIE,
      };
      // 挿入順は z → a（subject の昇順とは逆）。更新はしない。
      await stores.auth.putIdentity(first);
      await stores.auth.putIdentity(second);

      const subjects = (await stores.auth.listIdentities('account-1')).map((it) => it.subject);
      expect(subjects).toEqual(['sub-a', 'sub-z']);
    });

    it('listAccessTokens: 同着の2行のうち先に作ったほうだけ後から更新すると、id 昇順のまま動かない', async () => {
      await stores.auth.putAccount(account);
      const first = {
        id: 'token-first',
        accountId: 'account-1',
        sha256: 'a'.repeat(64),
        label: 'first',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      const second = {
        id: 'token-second',
        accountId: 'account-1',
        sha256: 'b'.repeat(64),
        label: 'second',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      await stores.auth.putAccessToken(first);
      await stores.auth.putAccessToken(second);
      await stores.auth.putAccessToken({ ...first, lastUsedAt: '2026-01-06T00:00:00.000Z' });

      const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
      expect(ids).toEqual(['token-first', 'token-second']);
    });

    it('listAccessTokens: 同着2行を2次キー（id）と逆順に挿入しても、id 昇順で返る', async () => {
      await stores.auth.putAccount(account);
      const first = {
        id: 'token-z',
        accountId: 'account-1',
        sha256: 'a'.repeat(64),
        label: 'z',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      const second = {
        id: 'token-a',
        accountId: 'account-1',
        sha256: 'b'.repeat(64),
        label: 'a',
        createdAt: TIE,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      };
      // 挿入順は z → a（id の昇順とは逆）。更新はしない。
      await stores.auth.putAccessToken(first);
      await stores.auth.putAccessToken(second);

      const ids = (await stores.auth.listAccessTokens('account-1')).map((it) => it.id);
      expect(ids).toEqual(['token-a', 'token-z']);
    });
  });

  it('許可の2値を書き換えられる（alteroid access grant の実体）', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putAccount({
      ...account,
      grantedAt: '2026-01-02T00:00:00.000Z',
      grantedBy: 'operator',
    });

    const stored = await stores.auth.getAccount('account-1');
    expect(stored?.grantedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(stored?.grantedBy).toBe('operator');
    // 上書きであって増殖ではない
    expect(await stores.auth.listAccounts()).toHaveLength(1);
  });

  it('検証済みメールからアカウントを引ける（相乗りの検査に使う）', async () => {
    await stores.auth.putAccount(account);

    expect((await stores.auth.findAccountByEmail('owner@example.test'))?.id).toBe('account-1');
    expect(await stores.auth.findAccountByEmail('別人@example.test')).toBeNull();
  });

  it('identity は (provider, subject) で一意（同じ人の入り直しで増えない）', async () => {
    await stores.auth.putAccount(account);
    const identity = {
      provider: 'google',
      subject: 'sub-1',
      accountId: 'account-1',
      email: 'owner@example.test',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-01-01T00:00:00.000Z',
    };
    await stores.auth.putIdentity(identity);
    await stores.auth.putIdentity({ ...identity, lastLoginAt: '2026-01-05T00:00:00.000Z' });

    const identities = await stores.auth.listIdentities('account-1');
    expect(identities).toHaveLength(1);
    expect(identities[0]?.lastLoginAt).toBe('2026-01-05T00:00:00.000Z');
    expect((await stores.auth.findIdentity('google', 'sub-1'))?.accountId).toBe('account-1');
    expect(await stores.auth.findIdentity('google', '別の sub')).toBeNull();
  });

  it('アクセストークンは sha256 で引ける（素の値は持たない）', async () => {
    await stores.auth.putAccount(account);
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    };
    await stores.auth.putAccessToken(token);

    expect(await stores.auth.findAccessTokenBySha256('a'.repeat(64))).toEqual(token);
    expect(await stores.auth.findAccessTokenBySha256('b'.repeat(64))).toBeNull();
    expect(await stores.auth.listAccessTokens('account-1')).toEqual([token]);
  });

  /**
   * `revokeAccessToken`（issue #1757、ログアウトの実体）。
   *
   * **1本だけを失効させる。冪等——先に立った時刻を後から動かさない。**
   * 条件付き UPDATE（`revoked_at is null`）で強制する（`packages/storage-pg/
   * src/auth.ts` の doc）。
   */
  describe('revokeAccessToken', () => {
    const token = {
      id: 'token-1',
      accountId: 'account-1',
      sha256: 'a'.repeat(64),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };

    it('失効させる（revokedAt が立ち、他のトークンは影響を受けない）', async () => {
      await stores.auth.putAccount(account);
      await stores.auth.putAccessToken(token);
      const other = { ...token, id: 'token-2', sha256: 'b'.repeat(64) };
      await stores.auth.putAccessToken(other);

      const result = await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
      expect(result).toEqual({
        status: 'revoked',
        token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
      });
      expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
        '2026-01-02T00:00:00.000Z',
      );
      // 同じアカウントの別のトークンは巻き込まれない。
      expect((await stores.auth.findAccessTokenBySha256('b'.repeat(64)))?.revokedAt).toBeNull();
    });

    it('もう一度呼んでも、先に立った時刻を動かさない（冪等）', async () => {
      await stores.auth.putAccount(account);
      await stores.auth.putAccessToken(token);

      await stores.auth.revokeAccessToken('token-1', '2026-01-02T00:00:00.000Z');
      const second = await stores.auth.revokeAccessToken('token-1', '2026-01-03T00:00:00.000Z');

      expect(second).toEqual({
        status: 'already_revoked',
        token: { ...token, revokedAt: '2026-01-02T00:00:00.000Z' },
      });
      expect((await stores.auth.findAccessTokenBySha256('a'.repeat(64)))?.revokedAt).toBe(
        '2026-01-02T00:00:00.000Z',
      );
    });

    it('無い id は not_found', async () => {
      expect(await stores.auth.revokeAccessToken('居ない', '2026-01-02T00:00:00.000Z')).toEqual({
        status: 'not_found',
      });
    });
  });

  it('ログイン要求を保存して読み戻せる（ブラウザ往復の突き合わせ）', async () => {
    const request = {
      id: 'login-1',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'c'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending' as const,
      accountId: null,
      error: null,
    };
    await stores.auth.putLoginRequest(request);
    expect(await stores.auth.getLoginRequest('login-1')).toEqual(request);

    await stores.auth.putLoginRequest({ ...request, status: 'consumed' as const });
    expect((await stores.auth.getLoginRequest('login-1'))?.status).toBe('consumed');
    expect(await stores.auth.getLoginRequest('居ない')).toBeNull();
  });
  it('ログイン要求の引き取りは1回だけ成功する（並行でも二重発行させない）', async () => {
    const request = {
      id: 'login-2',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'd'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated' as const,
      accountId: 'account-1',
      error: null,
    };
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest(request);

    // 読んでから書く形だと、ここで全部が authenticated を掴んでしまう。
    let issued = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        stores.auth.claimLoginRequest('login-2', (request) => ({
          id: `token-race-${++issued}`,
          accountId: request.accountId ?? '',
          sha256: String(issued).repeat(64).slice(0, 64),
          label: request.label,
          createdAt: '2026-01-02T00:00:00.000Z',
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        })),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-2'))?.status).toBe('consumed');
    // 保存されたトークンも1本だけ（応答が1件でも器に2本あれば通ってしまう）。
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
    // 一度 consumed になったら、あとから何度呼んでも取れない。
    expect(await stores.auth.claimLoginRequest('login-2', () => neverIssued())).toBeNull();
  });

  it('pending のログイン要求は引き取れない（ブラウザ側が終わる前に発行しない）', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-3',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'e'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    expect(await stores.auth.claimLoginRequest('login-3', () => neverIssued())).toBeNull();
    expect((await stores.auth.getLoginRequest('login-3'))?.status).toBe('pending');
    expect(await stores.auth.claimLoginRequest('居ない', () => neverIssued())).toBeNull();
  });
  /**
   * ⚠️ **2026-09-09 に期待値を反転した。** 反転前は「別々のアカウントへ同時に grant
   * しても、持ち主は1人しかできない」で、最後の砦は部分一意索引
   * `auth_accounts_single_owner_idx` だった。**索引ごと落としてある**
   * （`migrate.ts` の末尾の `drop index`。create は配列から消した）。
   *
   * fs 側と同じ2本に分けてある —— 上限が無いことと、`grantedBy` が上書きされないこと。
   */
  it('別々のアカウントへ同時に grant すると、両方通る（上限が無い）', async () => {
    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantAccess('account-1', at, 'operator'),
      stores.auth.grantAccess('account-2', at, 'operator'),
    ]);

    expect(results.filter((result) => result.status === 'granted')).toHaveLength(2);
    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(2);
  });

  it('同じアカウントへ同時に grant しても、grantedBy は先に書いた側のまま', async () => {
    await stores.auth.putAccount(account);

    const at = '2026-01-02T00:00:00.000Z';
    const results = await Promise.all([
      stores.auth.grantAccess('account-1', at, 'operator'),
      stores.auth.grantAccess('account-1', at, 'account-9'),
    ]);

    expect(results.every((result) => result.status === 'granted')).toBe(true);
    const stored = (await stores.auth.listAccounts()).find((it) => it.id === 'account-1');
    expect(
      results.map((result) => (result.status === 'granted' ? result.account.grantedBy : null)),
    ).toEqual([stored?.grantedBy, stored?.grantedBy]);
  });

  /**
   * **issue #1714。** fs 側の同名の歯（`packages/storage-fs/src/index.test.ts`）
   * と同じ入力・同じ期待値。同じ `(provider, subject)` の identity を2つの
   * 呼び出しが同時に作ろうとしても、account / identity とも1つしか作られない
   * こと——負けた側の account はトランザクションごと巻き戻り、孤児として
   * 残らない。
   *
   * **変異**: `createAccountWithIdentity` の `onConflictDoNothing` を外す、
   * または `identityRows.length === 0` のときの `tx.rollback()` を外す
   * （account だけ残る形）と、この歯は赤に戻る。
   */
  it('createAccountWithIdentity を同じ identity で並行に呼んでも、1つだけ作られる（負けた側の account は孤児にならない）', async () => {
    const makeInput = (accountId: string) => ({
      account: {
        id: accountId,
        displayName: 'Someone',
        email: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
      },
      identity: {
        provider: 'google',
        subject: 'sub-race',
        accountId,
        email: 'race@example.test',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const results = await Promise.all([
      stores.auth.createAccountWithIdentity(makeInput('account-race-a')),
      stores.auth.createAccountWithIdentity(makeInput('account-race-b')),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const loser = results.find((result) => !result.created);
    expect(loser).toBeDefined();
    if (loser !== undefined && !loser.created) {
      expect(loser.existing.subject).toBe('sub-race');
    }

    const identities = await stores.auth.listIdentities('account-race-a');
    const identitiesB = await stores.auth.listIdentities('account-race-b');
    expect(identities.length + identitiesB.length).toBe(1);

    // 負けた側の account はトランザクションごと巻き戻るので、孤児が残らない。
    const accounts = (await stores.auth.listAccounts()).filter((it) =>
      it.id.startsWith('account-race-'),
    );
    expect(accounts).toHaveLength(1);
  });

  /**
   * **issue #1714（レビュー修正）。** 2つの候補 account が**同じ検証済み
   * メール**を持つ状態で同時に作られると、`auth_accounts_email_lower_idx`
   * （#1702。`lower(email)` の一意索引）に当たりうる——`completeLogin` の
   * 外側の衝突検査（`findAccountByEmail`）は、同じ identity の2つのログインが
   * 同時に着けば両方が「衝突なし」を見るので、候補 account に同じ検証済み
   * メールを載せる（直上の歯は `email: null` なので、この形を測っていない）。
   *
   * **account を先に insert する実装だと、負けた側は identity の一意制約に
   * 辿り着く前にメールの一意制約違反という別の例外で落ちる**（`completeLogin`
   * は例外を投げてログインごと失敗する。`tx.rollback()` は起こらない）。
   * identity を先に insert する実装なら、負けた側は identity 側の一意制約
   * だけで do nothing になり、メールの索引には当たらない。
   *
   * **変異**: account の insert を identity より先に戻すと、この歯は赤に戻る
   * （`AssertionError` ではなく `duplicate key value violates unique
   * constraint "auth_accounts_email_lower_idx"` で reject する）。
   */
  it('createAccountWithIdentity: 2つの候補が同じ検証済みメールを持っていても、投げずに1つだけ作られる', async () => {
    const makeInput = (accountId: string) => ({
      account: {
        id: accountId,
        displayName: 'Someone',
        email: 'shared@example.test',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
        grantedAt: null,
        grantedBy: null,
        ownerDeclaredAt: null,
      },
      identity: {
        provider: 'google',
        subject: 'sub-email-race',
        accountId,
        email: 'shared@example.test',
        emailVerified: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const results = await Promise.all([
      stores.auth.createAccountWithIdentity(makeInput('account-email-race-a')),
      stores.auth.createAccountWithIdentity(makeInput('account-email-race-b')),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const loser = results.find((result) => !result.created);
    expect(loser).toBeDefined();
    if (loser !== undefined && !loser.created) {
      expect(loser.existing.subject).toBe('sub-email-race');
    }

    const accounts = (await stores.auth.listAccounts()).filter((it) =>
      it.id.startsWith('account-email-race-'),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.email).toBe('shared@example.test');
  });

  /**
   * **⭐ 2周目でだけ壊れる状態を挟む歯。**
   *
   * `migrate` は起動のたびに `STATEMENTS` を頭から通す。単一持ち主の索引
   * （`auth_accounts_single_owner_idx`）を落とすとき、**対になる `create unique index
   * if not exists` を配列に残すと、2周目は名前で一致せず本当に作りに行く。** そのとき
   * には2つ目の許可済みの行 —— 新しい規則が許し、古い索引が拒む行 —— が積まれていて、
   * `could not create unique index … is duplicated` で落ちる。**デーモンが2度と起動
   * できなくなる**（2026-08-25 に `usage_daily_key_idx` で実際に起きた形）。
   *
   * **「migrate を2回通す」だけでは1文字も測れない。** 許可済みの行が1つしか無ければ
   * 古い索引でも一意なので、2周目の create は通ってしまう。**2人目を挟むところまでが
   * 歯である。**
   *
   * `migrate.test.ts` の構造の歯（drop と create が同じ配列に並んでいないか）とは
   * 別物である —— あちらは配列の形を、ここは実際の DB の振る舞いを見る。
   */
  it('許可を2つ積んでから起動し直しても migrate が落ちない（古い索引を作りに戻らない）', async () => {
    // 2026-09-09 より前に作られた DB を模す —— そこには索引が在る。
    await db.execute(
      sql.raw(
        `create unique index if not exists auth_accounts_single_owner_idx
           on auth_accounts ((granted_at is not null)) where granted_at is not null`,
      ),
    );

    // 起動（この周で索引が落ちる）。
    await migrate(db);

    const other = { ...account, id: 'account-2', email: 'other@example.test' };
    await stores.auth.putAccount(account);
    await stores.auth.putAccount(other);
    const at = '2026-01-02T00:00:00.000Z';
    await stores.auth.grantAccess('account-1', at, 'operator');
    await stores.auth.grantAccess('account-2', at, 'operator');

    // ⭐ ここが本体。create が配列に残っていれば、この2周目で落ちる。
    await expect(migrate(db)).resolves.toBeUndefined();
    await expect(migrate(db)).resolves.toBeUndefined();

    const granted = (await stores.auth.listAccounts()).filter((it) => it.grantedAt !== null);
    expect(granted).toHaveLength(2);
  });

  it('トークンの保存が落ちたら、ログイン要求は authenticated のまま残る', async () => {
    await stores.auth.putAccount(account);
    await stores.auth.putLoginRequest({
      id: 'login-4',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'f'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'authenticated',
      accountId: 'account-1',
      error: null,
    });

    // 消費だけ先に確定してしまうと、トークンは返らないのに二度と引き取れなくなる。
    await expect(
      stores.auth.claimLoginRequest('login-4', () => {
        throw new Error('トークンを作れなかった');
      }),
    ).rejects.toThrow();
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('authenticated');

    // 直れば、同じ要求をそのまま引き取れる。
    const claimed = await stores.auth.claimLoginRequest('login-4', (request) => ({
      id: 'token-4',
      accountId: request.accountId ?? '',
      sha256: 'b'.repeat(64),
      label: request.label,
      createdAt: '2026-01-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    }));
    expect(claimed?.token.id).toBe('token-4');
    expect((await stores.auth.getLoginRequest('login-4'))?.status).toBe('consumed');
    expect(await stores.auth.listAccessTokens('account-1')).toHaveLength(1);
  });
  it('交換へ進む権利は1つのリクエストしか取れない', async () => {
    await stores.auth.putLoginRequest({
      id: 'login-5',
      provider: 'google',
      nonce: 'nonce',
      codeVerifier: 'verifier',
      claimSha256: 'a'.repeat(64),
      redirectUri: 'http://127.0.0.1:4517/auth/google/callback',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      status: 'pending',
      accountId: null,
      error: null,
    });

    // 読んでから書く形だと、全部が pending を通過して全部が交換へ進む。
    const results = await Promise.all(
      Array.from({ length: 5 }, () => stores.auth.beginLoginExchange('login-5')),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await stores.auth.getLoginRequest('login-5'))?.status).toBe('processing');
    // 一度 processing になったら、あとから何度呼んでも取れない。
    expect(await stores.auth.beginLoginExchange('login-5')).toBeNull();
    expect(await stores.auth.beginLoginExchange('居ない')).toBeNull();
  });

  /**
   * **`setAccountOwner` の不変条件（issue #1198）: 宣言（`declaredAt !== null`）は
   * 「許可済みの行にしか立たない」。** fs / pg / in-memory の3実装すべてで測る
   * （このファイルは pg、`packages/storage-fs/src/index.test.ts` が fs、
   * `packages/core/src/auth-service.test.ts` は in-memory を経由する）。pg 側は
   * `where granted_at is not null` を伴う条件付き UPDATE で強制する
   * （`packages/storage-pg/src/auth.ts` の doc）。
   */
  describe('setAccountOwner（実行環境の持ち主としての宣言）', () => {
    it('許可済みの行には宣言を立てられる', async () => {
      await stores.auth.putAccount({
        ...account,
        grantedAt: '2026-01-02T00:00:00.000Z',
        grantedBy: 'operator',
      });

      const result = await stores.auth.setAccountOwner('account-1', '2026-01-03T00:00:00.000Z');
      expect(result).toEqual({
        status: 'ok',
        account: {
          ...account,
          grantedAt: '2026-01-02T00:00:00.000Z',
          grantedBy: 'operator',
          ownerDeclaredAt: '2026-01-03T00:00:00.000Z',
        },
      });
      expect((await stores.auth.getAccount('account-1'))?.ownerDeclaredAt).toBe(
        '2026-01-03T00:00:00.000Z',
      );
    });

    it('未許可の行へ宣言しようとすると not_granted（不変条件「宣言 ⟹ 許可済み」）', async () => {
      await stores.auth.putAccount(account);

      const result = await stores.auth.setAccountOwner('account-1', '2026-01-03T00:00:00.000Z');
      expect(result).toEqual({ status: 'not_granted' });
      // 書かれていないこと。
      expect((await stores.auth.getAccount('account-1'))?.ownerDeclaredAt).toBeNull();
    });

    it('存在しないアカウントへの宣言は not_found', async () => {
      expect(await stores.auth.setAccountOwner('居ない', '2026-01-03T00:00:00.000Z')).toEqual({
        status: 'not_found',
      });
    });

    it('取り消し（null）は許可の有無を問わず常に通る', async () => {
      await stores.auth.putAccount(account);

      const result = await stores.auth.setAccountOwner('account-1', null);
      expect(result).toEqual({ status: 'ok', account });
    });

    it('存在しないアカウントの取り消しは not_found', async () => {
      expect(await stores.auth.setAccountOwner('居ない', null)).toEqual({ status: 'not_found' });
    });
  });

  /**
   * **大小文字だけが違う検証済みメールも衝突として検出する（pg。issue #1702）。**
   *
   * `packages/core/src/auth-service.test.ts` / `packages/storage-fs/src/
   * index.test.ts` の同名の歯と同じ入力・同じ期待値を、`createAuthService`
   * （`auth-service.ts` の実コード。器だけ pg へ差し替える）に対して確かめる。
   * issue #1688 でこの歯は `findAccountByEmail` が SQL の `=`（大小文字を
   * 区別する）で比較していたために red だった（オーナー判断は #1702：メール
   * の大小文字は区別しない。一意索引も `lower(email)` へ移した）。いまは
   * green であることが保証。
   */
  describe('大小文字だけが違う検証済みメール（#1702）', () => {
    function fakeProvider(profiles: Record<string, OAuthProfile>): OAuthProvider {
      return {
        kind: 'oauth2',
        id: 'fake',
        label: 'Fake',
        authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
        exchange: async ({ code }) => {
          const profile = profiles[code];
          if (profile === undefined) throw new Error(`未知の code: ${code}`);
          return profile;
        },
      };
    }

    it('大小文字だけが違う検証済みメールも衝突として検出し、2つ目のアカウントには乗せない', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-case': {
              subject: 'sub-impostor-case',
              email: 'ALICE@EXAMPLE.TEST',
              emailVerified: true,
              displayName: 'Not Alice (case)',
            },
          }),
        ]),
      });

      async function login(code: string): Promise<{ requestId: string; claimSecret: string }> {
        const started = await service.startLogin({
          provider: 'fake',
          redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
        });
        const state = decodeState(
          new URL(started.authorizationUrl).searchParams.get('state') ?? '',
        );
        expect(state).not.toBeNull();
        const completed = await service.completeLogin({
          state: `${state?.requestId}.${state?.nonce}`,
          code,
        });
        expect(completed.status).toBe('ok');
        return { requestId: started.requestId, claimSecret: started.claimSecret };
      }

      const alice = await login('code-alice');
      const claimedAlice = await service.claim(alice);
      if (claimedAlice.status !== 'ready') throw new Error('ログインできていない');
      expect(claimedAlice.account.email).toBe('alice@example.test');

      const impostorCase = await login('code-impostor-case');
      const claimedImpostorCase = await service.claim(impostorCase);
      if (claimedImpostorCase.status !== 'ready') throw new Error('ログインできていない');

      expect(claimedImpostorCase.account.id).not.toBe(claimedAlice.account.id);
      // 大小文字を区別せずに衝突を検出しているので null（#1702）。
      expect(claimedImpostorCase.account.email).toBeNull();
    });

    /**
     * **issue #1751（同じ穴が #1741 にも起票されている。pg）。**
     *
     * `createAccountWithIdentity`（#1714）が当初1操作にしたのは同じ
     * `(provider, subject)` の競合だけだった。メールの衝突検査
     * （`findAccountByEmail`）は `completeLogin` の読んでから書く側に残って
     * いたので、**別々の** identity が大小文字だけ違う検証済みメールで同時に
     * ログインしてくると、両方が「衝突なし」を見て、両方が
     * `createAccountWithIdentity` へ進んでいた。pg には
     * `auth_accounts_email_lower_idx`（#1702）があるので、**直す前は片方が
     * 生の一意制約違反（23505）で reject していた**（`allSettled` で見た実測。
     * `Promise.all` にすると片方の reject がテスト自体を失敗させていた）。
     *
     * いまは衝突検査自体を `createAccountWithIdentity` の1トランザクションへ
     * 移したので、**両方とも `ok` で返り、例外は1本も出ない**——`Promise.all`
     * に戻して確かめる（`allSettled` のままだと reject が起きても検出できない）。
     *
     * **変異**: `packages/storage-pg/src/auth.ts` の `createAccountWithIdentity`
     * にある事前 select、または2回目の `onConflictDoNothing` の insert（メールを
     * 空にした入れ直し）を外すと、この歯は赤に戻る（`AssertionError` ではなく
     * `duplicate key value violates unique constraint "auth_accounts_email_
     * lower_idx"` で reject する）。
     */
    it('r2: 別々の identity が大小文字だけ違う検証済みメールで同時にログインしても、投げずに検証済みメールを持つアカウントは1つだけ', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-case': {
              subject: 'sub-impostor-case',
              email: 'ALICE@EXAMPLE.TEST',
              emailVerified: true,
              displayName: 'Not Alice (case)',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
      const stateSecond = decodeState(
        new URL(second.authorizationUrl).searchParams.get('state') ?? '',
      );
      expect(stateFirst).not.toBeNull();
      expect(stateSecond).not.toBeNull();

      const [resultA, resultB] = await Promise.all([
        service.completeLogin({
          state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
          code: 'code-alice',
        }),
        service.completeLogin({
          state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
          code: 'code-impostor-case',
        }),
      ]);

      expect(resultA.status).toBe('ok');
      expect(resultB.status).toBe('ok');
      if (resultA.status !== 'ok' || resultB.status !== 'ok') {
        throw new Error('ログインできていない');
      }
      expect(resultA.accountId).not.toBe(resultB.accountId);

      const accounts = await stores.auth.listAccounts();
      expect(accounts).toHaveLength(2);
      const withVerifiedEmail = accounts.filter((account) => account.email !== null);
      expect(withVerifiedEmail).toHaveLength(1);
    });

    /** **issue #1741（大小文字が同じ版。#1751 と同じ穴）。** */
    it('#1741: 別々の identity が大小文字まで同じ検証済みメールで同時にログインしても、投げずに検証済みメールを持つアカウントは1つだけ', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
            'code-impostor-samecase': {
              subject: 'sub-impostor-samecase',
              email: 'alice@example.test',
              emailVerified: true,
              displayName: 'Not Alice (same case)',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
      const stateSecond = decodeState(
        new URL(second.authorizationUrl).searchParams.get('state') ?? '',
      );
      expect(stateFirst).not.toBeNull();
      expect(stateSecond).not.toBeNull();

      const [resultA, resultB] = await Promise.all([
        service.completeLogin({
          state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
          code: 'code-alice',
        }),
        service.completeLogin({
          state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
          code: 'code-impostor-samecase',
        }),
      ]);

      expect(resultA.status).toBe('ok');
      expect(resultB.status).toBe('ok');
      if (resultA.status !== 'ok' || resultB.status !== 'ok') {
        throw new Error('ログインできていない');
      }
      expect(resultA.accountId).not.toBe(resultB.accountId);

      const accounts = await stores.auth.listAccounts();
      expect(accounts).toHaveLength(2);
      const withVerifiedEmail = accounts.filter((account) => account.email !== null);
      expect(withVerifiedEmail).toHaveLength(1);
    });

    /**
     * **ストアの層（issue #1751 / #1741）。** `completeLogin` を経由せず、
     * `AuthStore.createAccountWithIdentity` を直接、**別々の** identity・
     * **同じ**候補メールで並行に呼ぶ。core（memory）・fs 側の同名の歯と同じ
     * 入力・同じ期待値。
     *
     * **変異**: `createAccountWithIdentity` の事前 select、または2回目の
     * insert（メールを空にした入れ直し）を外すと、この歯は赤に戻る。
     */
    it('createAccountWithIdentity を別々の identity・同じ候補メールで並行に呼んでも、投げずにメールが載るのは1つだけ', async () => {
      const makeInput = (accountId: string, subject: string) => ({
        account: {
          id: accountId,
          displayName: 'Someone',
          email: 'shared@example.test',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-01T00:00:00.000Z',
          grantedAt: null,
          grantedBy: null,
          ownerDeclaredAt: null,
        },
        identity: {
          provider: 'google',
          subject,
          accountId,
          email: 'shared@example.test',
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-01T00:00:00.000Z',
        },
      });

      const results = await Promise.all([
        stores.auth.createAccountWithIdentity(makeInput('account-diff-identity-a', 'sub-diff-a')),
        stores.auth.createAccountWithIdentity(makeInput('account-diff-identity-b', 'sub-diff-b')),
      ]);

      expect(results.every((result) => result.created)).toBe(true);
      const emails = results.map((result) => (result.created ? result.account.email : null));
      expect(emails.filter((email) => email !== null)).toHaveLength(1);

      const accounts = (await stores.auth.listAccounts()).filter((it) =>
        it.id.startsWith('account-diff-identity-'),
      );
      expect(accounts).toHaveLength(2);
      expect(accounts.filter((it) => it.email !== null)).toHaveLength(1);
    });

    /**
     * **#1702 の重複状態（旧索引だけの DB）でも投げないこと。** `migrate.test.ts`
     * の `makeOldFormatDb` と同じ作り方——空の DB へ `migrate` を通した直後に
     * 新索引（`auth_accounts_email_lower_idx`）を drop し、大小文字を区別する
     * 旧索引（`auth_accounts_email_idx`）を作り直す。この DB には「大小文字
     * だけが違う検証済みメール」を拒む制約が無いので、DB 制約側の
     * `onConflictDoNothing` はここでは効かない——効くのはアプリの層の事前
     * select だけである。
     *
     * ⚠️ **確かめるのは「投げないこと」だけである。** 事前 select と insert の
     * 間の競合windowは塞がっていない（`auth.ts` の doc）ので、大小文字違いの
     * 重複ができないことまでは保証しない——ここでは重複の有無を assert しない。
     */
    it('#1702 の重複状態（旧索引だけの DB）でも、別々の identity・大小文字違いの候補メールで並行に呼んでも投げない', async () => {
      const localClient = new PGlite();
      const localDb = drizzle(localClient);
      await migrate(localDb);
      await localDb.execute(sql.raw(`drop index if exists ${AUTH_ACCOUNTS_EMAIL_LOWER_INDEX}`));
      await localDb.execute(
        sql.raw(
          'create unique index if not exists auth_accounts_email_idx on auth_accounts (email)',
        ),
      );
      const localStores = createPgStoresFromDb(localDb);

      const makeInput = (accountId: string, subject: string, email: string) => ({
        account: {
          id: accountId,
          displayName: 'Someone',
          email,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-01T00:00:00.000Z',
          grantedAt: null,
          grantedBy: null,
          ownerDeclaredAt: null,
        },
        identity: {
          provider: 'google',
          subject,
          accountId,
          email,
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-01T00:00:00.000Z',
        },
      });

      await expect(
        Promise.all([
          localStores.auth.createAccountWithIdentity(
            makeInput('account-old-format-a', 'sub-old-format-a', 'alice@example.test'),
          ),
          localStores.auth.createAccountWithIdentity(
            makeInput('account-old-format-b', 'sub-old-format-b', 'ALICE@EXAMPLE.TEST'),
          ),
        ]),
      ).resolves.toBeDefined();

      await localClient.close();
    });
  });

  /**
   * **issue #1714（レビュー修正）。** `packages/core/src/auth-service.test.ts`
   * の同名の歯（メモリ実装）と同じ入力・同じ期待値を、`createAuthService`
   * （実コード。器だけ pg へ差し替える）に対して確かめる。
   *
   * **ここが本番の形にいちばん近い。** メモリはどんな入力でも一意制約を
   * 持たないので、`AuthStore.createAccountWithIdentity` の内部の順序を
   * 間違えても検出できない——`auth_accounts_email_lower_idx`（#1702）が
   * 実在する pg でだけ、account を先に insert する誤りが本物の一意制約違反
   * として現れる。この歯は最初の実装（account が先）では
   * `duplicate key value violates unique constraint
   * "auth_accounts_email_lower_idx"` で reject していた。
   */
  describe('同じ identity の同時ログイン（pg。issue #1714 のレビュー修正）', () => {
    function fakeProvider(profiles: Record<string, OAuthProfile>): OAuthProvider {
      return {
        kind: 'oauth2',
        id: 'fake',
        label: 'Fake',
        authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
        exchange: async ({ code }) => {
          const profile = profiles[code];
          if (profile === undefined) throw new Error(`未知の code: ${code}`);
          return profile;
        },
      };
    }

    it('同じ identity で2つのログインが同時に完了しても、アカウントは1つで両方が同じ accountId になる', async () => {
      const service = createAuthService({
        store: stores.auth,
        providers: createAuthProviderRegistry([
          fakeProvider({
            'code-alice': {
              subject: 'sub-alice-pg-race',
              email: 'alice-pg-race@example.test',
              emailVerified: true,
              displayName: 'Alice',
            },
          }),
        ]),
      });

      const first = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const second = await service.startLogin({
        provider: 'fake',
        redirectUri: 'http://127.0.0.1:4517/auth/fake/callback',
      });
      const stateFirst = decodeState(
        new URL(first.authorizationUrl).searchParams.get('state') ?? '',
      );
      const stateSecond = decodeState(
        new URL(second.authorizationUrl).searchParams.get('state') ?? '',
      );
      expect(stateFirst).not.toBeNull();
      expect(stateSecond).not.toBeNull();

      const [resultA, resultB] = await Promise.all([
        service.completeLogin({
          state: `${stateFirst?.requestId}.${stateFirst?.nonce}`,
          code: 'code-alice',
        }),
        service.completeLogin({
          state: `${stateSecond?.requestId}.${stateSecond?.nonce}`,
          code: 'code-alice',
        }),
      ]);

      expect(resultA.status).toBe('ok');
      expect(resultB.status).toBe('ok');
      if (resultA.status !== 'ok' || resultB.status !== 'ok') {
        throw new Error('ログインできていない');
      }
      expect(resultA.accountId).toBe(resultB.accountId);

      const accounts = await stores.auth.listAccounts();
      expect(accounts.filter((it) => it.email === 'alice-pg-race@example.test')).toHaveLength(1);
    });
  });
});

/** 引き取れないはずの経路で呼ばれたら、テストとして落とす。 */
function neverIssued(): never {
  throw new Error('引き取れないはずの要求でトークンを作ろうとした');
}

/**
 * 既定の idle 接続エラーハンドラ（Issue #1229）。
 *
 * **`createPgStores`（実接続を張る側）を直接は呼ばない。** 本物の `Pool` を
 * 立てるには実際の PostgreSQL が要る（`.claude/skills/postgres-in-container/
 * SKILL.md`）——ここで測りたいのは「idle 接続のエラーを受けたら何を書くか」
 * という整形の中身だけなので、その部分を `describePgConnectionError` として
 * 切り出してあり（`index.ts` の doc）、これを直接呼べば実接続は要らない。
 *
 * `journal` と `approvals` は同じ `Pool` を共有するので、この1行は
 * 「両方の書き込みが同時に塞がる窓」で残る唯一の跡になりうる
 * （Issue #1229 受け入れ基準2）——`error.message` だけだった以前は、
 * SQLSTATE のような切り分け材料をここでも捨てていた。
 */
describe('describePgConnectionError', () => {
  it('SQLSTATE 等の構造化フィールドが出る。detail の値は出ない', () => {
    const pgError = new Error('duplicate key value violates unique constraint "journal_pkey"');
    Object.assign(pgError, {
      code: '23505',
      constraint: 'journal_pkey',
      table: 'journal',
      // **detail は行の値そのものを転記する**（一意制約違反の定型文）——
      // 出てはいけない偽の「値」をここに置く。
      detail: 'Key (id)=(11111111-2222-3333-4444-555555555555) already exists.',
    });

    const line = describePgConnectionError(pgError);

    expect(line).toContain('alteroid: PostgreSQL の接続でエラー:');
    expect(line).toContain('code=23505');
    expect(line).toContain('constraint=journal_pkey');
    expect(line).toContain('table=journal');
    expect(line).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('SQLSTATE を持たない素の Error でも落ちない（メッセージだけ出る）', () => {
    const line = describePgConnectionError(new Error('ECONNRESET'));

    expect(line).toContain('ECONNRESET');
  });
});
