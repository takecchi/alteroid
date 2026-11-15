import { describe, expect, it } from 'vitest';

import { createAuthProviderRegistry } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { accessTokenRecordSchema, sha256Hex, type AuthAccount } from './auth.js';
import { createMemoryStores } from './testing.js';

const NOW = new Date('2026-11-15T00:00:00.000Z');

function account(id: string): AuthAccount {
  return {
    id,
    displayName: id,
    email: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: '2026-01-01T00:00:00.000Z',
    grantedBy: 'operator',
  };
}

async function setup() {
  const stores = createMemoryStores();
  await stores.auth.putAccount(account('alice'));
  await stores.auth.putAccount(account('bob'));
  let seq = 0;
  const service = createAuthService({
    store: stores.auth,
    providers: createAuthProviderRegistry([]),
    now: () => NOW,
    newId: () => `id-${String((seq += 1))}`,
  });
  return { stores, service };
}

describe('発行したアクセストークン（issueAccessToken）', () => {
  it('値は結果でだけ返り、保存は sha256 だけ。種類・発行元・発行した主体が残り、authenticate が返す', async () => {
    const { stores, service } = await setup();
    const { token, value } = await service.issueAccessToken({
      accountId: 'alice',
      name: '別の環境',
      kind: 'read',
      expiresAt: null,
      issuedBy: 'alice',
    });
    expect(value).toMatch(/^alt_/);
    expect(token).toMatchObject({
      accountId: 'alice',
      label: '別の環境',
      kind: 'read',
      origin: 'issued',
      issuedBy: 'alice',
      expiresAt: null,
      revokedAt: null,
      sha256: sha256Hex(value),
    });
    expect(JSON.stringify(await stores.auth.listAccessTokens('alice'))).not.toContain(value);

    const authenticated = await service.authenticate(value);
    expect(authenticated).toMatchObject({
      account: { id: 'alice' },
      tokenId: token.id,
      kind: 'read',
      origin: 'issued',
    });
  });

  it('beforeSave が投げたら保存しない（HTTP の口が日誌を先に書くための口）', async () => {
    const { stores, service } = await setup();
    await expect(
      service.issueAccessToken({
        accountId: 'alice',
        name: 'x',
        kind: 'full',
        expiresAt: null,
        issuedBy: 'operator',
        beforeSave: () => Promise.reject(new Error('journal down (test)')),
      }),
    ).rejects.toThrow('journal down');
    expect(await stores.auth.listAccessTokens('alice')).toEqual([]);
  });
});

describe('この欄が無かった頃にログインで発行済みの行', () => {
  it('kind: full・origin: login・issuedBy: null として読め、authenticate で full・login として動き続ける', async () => {
    const legacy = {
      id: 'legacy-1',
      accountId: 'alice',
      sha256: sha256Hex('alt_legacy-token'),
      label: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    expect(accessTokenRecordSchema.parse(legacy)).toMatchObject({
      kind: 'full',
      origin: 'login',
      issuedBy: null,
    });
    const { stores, service } = await setup();
    await stores.auth.putAccessToken(accessTokenRecordSchema.parse(legacy));
    expect(await service.authenticate('alt_legacy-token')).toMatchObject({
      tokenId: 'legacy-1',
      kind: 'full',
      origin: 'login',
    });
  });
});

describe('アクセストークンの一覧と id 指定の失効', () => {
  it('一覧はそのアカウントのトークンだけ。他のアカウントの id は失効できない（not_found で状態を変えない）', async () => {
    const { stores, service } = await setup();
    const mine = await service.issueAccessToken({
      accountId: 'alice',
      name: 'a',
      kind: 'read',
      expiresAt: null,
      issuedBy: 'alice',
    });
    const theirs = await service.issueAccessToken({
      accountId: 'bob',
      name: 'b',
      kind: 'full',
      expiresAt: null,
      issuedBy: 'bob',
    });
    expect((await service.listAccessTokens('alice')).map((it) => it.id)).toEqual([mine.token.id]);

    expect(await service.revokeAccessTokenById('alice', theirs.token.id)).toEqual({
      status: 'not_found',
    });
    expect((await stores.auth.listAccessTokens('bob'))[0]?.revokedAt).toBeNull();
  });

  it('失効は冪等で、先に立った時刻を動かさない', async () => {
    const { stores, service } = await setup();
    const issued = await service.issueAccessToken({
      accountId: 'alice',
      name: 'a',
      kind: 'read',
      expiresAt: null,
      issuedBy: 'alice',
    });
    const first = await service.revokeAccessTokenById('alice', issued.token.id);
    expect(first.status).toBe('revoked');
    // 時計を進めた別のサービスで2回目を呼ぶ: 先の時刻が動かないことを見る
    const later = createAuthService({
      store: stores.auth,
      providers: createAuthProviderRegistry([]),
      now: () => new Date(NOW.getTime() + 60_000),
    });
    const second = await later.revokeAccessTokenById('alice', issued.token.id);
    expect(second.status).toBe('already_revoked');
    expect((await stores.auth.listAccessTokens('alice'))[0]?.revokedAt).toBe(NOW.toISOString());
    expect(await service.authenticate(issued.value)).toBeNull();
  });
});
