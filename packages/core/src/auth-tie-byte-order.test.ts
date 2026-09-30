import { describe, expect, it } from 'vitest';

import type { AccessTokenRecord, AuthAccount, AuthIdentity } from './auth.js';
import { createMemoryStores } from './testing.js';

/**
 * **issue #2458。** `AuthStore` の一覧の同着（`createdAt` が完全に同じ）の2次キーを、
 * fs / インメモリは `localeCompare`（照合順）で、pg は列の既定の照合順（PGlite は C）
 * で比べていたので、大文字と小文字、`-` と `_` が混ざると3実装で逆順になっていた。
 * 直した後は、JS 側はコード単位の比較、pg 側は `COLLATE "C"` の明示で、3実装とも
 * バイト順に揃う。
 *
 * **同じ入力・同じ期待値の歯が3つ在る。1つで測って3つとも測ったことにしない:**
 *
 * - インメモリ — このファイル
 * - fs — `packages/storage-fs/src/auth-tie-byte-order.test.ts`
 * - pg — `packages/storage-pg/src/auth-tie-byte-order.test.ts`（列の照合順を
 *   C 以外へ変えた DB でも同じ順になることを測る）
 *
 * 入力は `randomToken`（base64url）で実際に出る字——大文字・小文字・数字・`-`・`_`。
 * 挿入の順は期待値の逆にしてある。
 */
const TIE = '2026-01-05T00:00:00.000Z';
/** 期待値（C のバイト順）の逆の順。`localeCompare` では `_z, 9, a-x, ab, Ab, B_x` になる。 */
const INSERT_ORDER = ['ab', 'a-x', '_z', 'B_x', 'Ab', '9'];
const EXPECTED = ['9', 'Ab', 'B_x', '_z', 'a-x', 'ab'];
/**
 * `provider` は `authProviderIdSchema`（`/^[a-z][a-z0-9_-]{0,31}$/`）を通る字だけ。
 * その中でも `-` / 数字 / `_` の前後は照合順と C で食い違う。
 */
const PROVIDER_INSERT_ORDER = ['ab', 'a_b', 'a0', 'a-b'];
const PROVIDER_EXPECTED = ['a-b', 'a0', 'a_b', 'ab'];

const account = (id: string): AuthAccount => ({
  id,
  displayName: null,
  email: null,
  createdAt: TIE,
  lastLoginAt: null,
  grantedAt: null,
  grantedBy: null,
  ownerDeclaredAt: null,
});

const identity = (provider: string, subject: string): AuthIdentity => ({
  provider,
  subject,
  accountId: 'account-1',
  email: null,
  emailVerified: false,
  createdAt: TIE,
  lastLoginAt: TIE,
});

const token = (id: string, n: number): AccessTokenRecord => ({
  id,
  accountId: 'account-1',
  sha256: n.toString(16).padStart(64, '0'),
  label: id,
  createdAt: TIE,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
});

describe('AuthStore の同着の2次キーはバイト順（インメモリ実装、issue #2458）', () => {
  it('前提: 入力は localeCompare とコード単位の比較で並びが食い違う組である', () => {
    expect([...INSERT_ORDER].sort((a, b) => a.localeCompare(b))).not.toEqual(EXPECTED);
    expect([...INSERT_ORDER].sort()).toEqual(EXPECTED);
    expect([...PROVIDER_INSERT_ORDER].sort((a, b) => a.localeCompare(b))).not.toEqual(
      PROVIDER_EXPECTED,
    );
    expect([...PROVIDER_INSERT_ORDER].sort()).toEqual(PROVIDER_EXPECTED);
  });

  it('listAccounts: 同着の id はバイト順', async () => {
    const auth = createMemoryStores().auth;
    for (const id of INSERT_ORDER) await auth.putAccount(account(id));

    expect((await auth.listAccounts()).map((it) => it.id)).toEqual(EXPECTED);
  });

  it('listIdentities: 同着の subject はバイト順', async () => {
    const auth = createMemoryStores().auth;
    await auth.putAccount({ ...account('account-1'), createdAt: '2026-01-01T00:00:00.000Z' });
    for (const subject of INSERT_ORDER) await auth.putIdentity(identity('google', subject));

    expect((await auth.listIdentities('account-1')).map((it) => it.subject)).toEqual(EXPECTED);
  });

  it('listIdentities: 同着の provider はバイト順', async () => {
    const auth = createMemoryStores().auth;
    await auth.putAccount({ ...account('account-1'), createdAt: '2026-01-01T00:00:00.000Z' });
    for (const provider of PROVIDER_INSERT_ORDER) await auth.putIdentity(identity(provider, 's'));

    expect((await auth.listIdentities('account-1')).map((it) => it.provider)).toEqual(
      PROVIDER_EXPECTED,
    );
  });

  it('listAccessTokens: 同着の id はバイト順', async () => {
    const auth = createMemoryStores().auth;
    await auth.putAccount({ ...account('account-1'), createdAt: '2026-01-01T00:00:00.000Z' });
    let n = 1;
    for (const id of INSERT_ORDER) await auth.putAccessToken(token(id, n++));

    expect((await auth.listAccessTokens('account-1')).map((it) => it.id)).toEqual(EXPECTED);
  });
});
