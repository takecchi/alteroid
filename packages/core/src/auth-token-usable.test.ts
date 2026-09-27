import { describe, expect, it } from 'vitest';

import { createAuthProviderRegistry } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import {
  ACCESS_TOKEN_PREFIX,
  isAccessTokenUsable,
  sha256Hex,
  type AccessTokenRecord,
  type AuthAccount,
  type AuthStore,
} from './auth.js';
import { createMemoryStores } from './testing.js';

/**
 * `isAccessTokenUsable()` は、**判定できない期限を「使えない」に倒す**（issue #1789）。
 *
 * 以前は `Date.parse(expiresAt) <= now` の形で比べていたので、解釈できない
 * `expiresAt`（`NaN`）は期限の検査を素通りして「使える」に倒れていた。
 * スキーマ（`isoDateTime`）は書き込みの時点で解釈できない値を拒むので、ここで
 * 壊れた値を作るには、書き込みの検査を迂回する（ストアの読み出しを差し替える）
 * しかない——その迂回こそが、この判定が守るべき場面である。
 */

const NOW = new Date('2026-09-27T00:00:00.000Z');

function tokenWith(overrides: Partial<AccessTokenRecord>): AccessTokenRecord {
  return {
    id: 'token-1',
    accountId: 'account-1',
    sha256: 'a'.repeat(64),
    label: 'laptop',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('isAccessTokenUsable（issue #1789）', () => {
  it.each(['not-a-date', '2026-13-01T00:00:00Z', '2026-09-27T25:00:00Z', ''])(
    '解釈できない expiresAt（%j）は「使えない」',
    (expiresAt) => {
      expect(Number.isNaN(Date.parse(expiresAt))).toBe(true);
      expect(isAccessTokenUsable(tokenWith({ expiresAt }), NOW)).toBe(false);
    },
  );

  it('期限より前は使える・期限ちょうどと過ぎた後は使えない・期限なしは使える（いままでどおり）', () => {
    expect(isAccessTokenUsable(tokenWith({ expiresAt: '2026-09-27T00:00:00.001Z' }), NOW)).toBe(
      true,
    );
    expect(isAccessTokenUsable(tokenWith({ expiresAt: '2026-09-27T00:00:00.000Z' }), NOW)).toBe(
      false,
    );
    expect(isAccessTokenUsable(tokenWith({ expiresAt: '2026-09-26T23:59:59.999Z' }), NOW)).toBe(
      false,
    );
    expect(isAccessTokenUsable(tokenWith({ expiresAt: null }), NOW)).toBe(true);
  });

  it('失効済みは、期限によらず使えない（いままでどおり）', () => {
    expect(
      isAccessTokenUsable(
        tokenWith({ revokedAt: '2026-09-01T00:00:00.000Z', expiresAt: null }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('authenticate は、壊れた expiresAt のトークンを拒む（issue #1789）', () => {
  const account: AuthAccount = {
    id: 'account-1',
    displayName: 'Owner',
    email: 'owner@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: '2026-01-01T00:00:00.000Z',
    grantedAt: '2026-01-01T00:00:00.000Z',
    grantedBy: 'operator',
    ownerDeclaredAt: null,
  };
  /** 偽の値。本物の資格ではない。 */
  const bearer = `${ACCESS_TOKEN_PREFIX}FAKEFAKEFAKEFAKE`;

  /**
   * 読み出しだけを差し替えたストア。メモリ実装は書き込みでスキーマを通すので
   * （#1715）、壊れた `expiresAt` は `putAccessToken` では入らない——検査を
   * 迂回して保存された値が読み出されてきた場面を、ここで作る。
   */
  function storeReturning(record: AccessTokenRecord): AuthStore {
    const { auth } = createMemoryStores();
    return {
      ...auth,
      findAccessTokenBySha256: async (hash) => (hash === record.sha256 ? record : null),
      getAccount: async (id) => (id === account.id ? account : null),
    };
  }

  function serviceWith(record: AccessTokenRecord) {
    return createAuthService({
      store: storeReturning(record),
      providers: createAuthProviderRegistry([]),
      now: () => NOW,
    });
  }

  it('解釈できない expiresAt のトークンでは、アカウントを返さない', async () => {
    const record = tokenWith({ sha256: sha256Hex(bearer), expiresAt: 'not-a-date' });
    expect(await serviceWith(record).authenticate(bearer)).toBeNull();
  });

  it('対照: 同じトークンで期限が未来なら、アカウントを返す', async () => {
    const record = tokenWith({
      sha256: sha256Hex(bearer),
      expiresAt: '2026-10-27T00:00:00.000Z',
    });
    expect((await serviceWith(record).authenticate(bearer))?.id).toBe(account.id);
  });
});
