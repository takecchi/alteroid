import { describe, expect, it } from 'vitest';

import { ACCESS_TOKEN_PREFIX, sha256Hex, type AuthStore } from './auth.js';
import { createAuthProviderRegistry } from './auth-providers.js';
import { createAuthService } from './auth-service.js';
import { captureStderr, createMemoryStores } from './testing.js';

// 「最後に使った時刻」が書けなくても照合の結果は変えない（#4788。#4755 の兄弟）
describe('アカウントの鍵の照合は、最後に使った時刻が書けなくても通す（#4788）', () => {
  it('⭐ markAccessTokenUsed が投げても、authenticate はアカウントを返し、stderr に1行残す', async () => {
    const inner = createMemoryStores().auth;
    const store: AuthStore = {
      ...inner,
      markAccessTokenUsed: () => Promise.reject(new Error('last used down (test)')),
    };
    await inner.putAccount({
      id: 'account-1',
      displayName: null,
      email: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      grantedAt: '2026-01-01T00:00:00.000Z',
      grantedBy: 'operator',
    });
    const bearer = `${ACCESS_TOKEN_PREFIX}test-value`;
    await inner.putAccessToken({
      id: 'token-1',
      accountId: 'account-1',
      sha256: sha256Hex(bearer),
      label: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    const service = createAuthService({ store, providers: createAuthProviderRegistry([]) });

    let account: Awaited<ReturnType<typeof service.authenticate>> = null;
    const lines = await captureStderr(async () => {
      account = await service.authenticate(bearer);
    });

    expect(account).not.toBeNull();
    expect((account as { id: string } | null)?.id).toBe('account-1');
    expect(lines.filter((line) => line.includes('last used down (test)'))).toHaveLength(1);
  });
});
