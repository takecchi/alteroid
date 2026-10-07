import type { AccessTokenRecord, AuthAccount, AuthIdentity, AuthStore } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

const TIE = '2026-01-05T00:00:00.000Z';
const INSERT_ORDER = ['ab', 'a-x', '_z', 'B_x', 'Ab', '9'];
const EXPECTED = ['9', 'Ab', 'B_x', '_z', 'a-x', 'ab'];
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

describe('AuthStore の同着の2次キーはバイト順（fs 実装、issue #2458）', () => {
  let auth: AuthStore;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    auth = createFsStores(root).auth;
  });

  it('listAccounts: 同着の id はバイト順', async () => {
    for (const id of INSERT_ORDER) await auth.putAccount(account(id));

    expect((await auth.listAccounts()).map((it) => it.id)).toEqual(EXPECTED);
  });

  it('listIdentities: 同着の subject はバイト順', async () => {
    await auth.putAccount({ ...account('account-1'), createdAt: '2026-01-01T00:00:00.000Z' });
    for (const subject of INSERT_ORDER) await auth.putIdentity(identity('google', subject));

    expect((await auth.listIdentities('account-1')).map((it) => it.subject)).toEqual(EXPECTED);
  });

  it('listIdentities: 同着の provider はバイト順', async () => {
    await auth.putAccount({ ...account('account-1'), createdAt: '2026-01-01T00:00:00.000Z' });
    for (const provider of PROVIDER_INSERT_ORDER) await auth.putIdentity(identity(provider, 's'));

    expect((await auth.listIdentities('account-1')).map((it) => it.provider)).toEqual(
      PROVIDER_EXPECTED,
    );
  });

  it('listAccessTokens: 同着の id はバイト順', async () => {
    await auth.putAccount({ ...account('account-1'), createdAt: '2026-01-01T00:00:00.000Z' });
    let n = 1;
    for (const id of INSERT_ORDER) await auth.putAccessToken(token(id, n++));

    expect((await auth.listAccessTokens('account-1')).map((it) => it.id)).toEqual(EXPECTED);
  });
});
