import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  UnreadableAccountError,
  UnreadablePermissionGrantError,
} from '@alteroid/core';
import type { AuthAccount, CloneHost, OAuthProvider, PermissionGrant } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

describe('取り消しの口は、読めない行を「見つからない」と言わない（fs。issue #2425）', () => {
  const PROVIDER: OAuthProvider = {
    kind: 'oauth2',
    id: 'fake',
    label: 'Fake',
    authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
    exchange: async () => ({
      subject: 'sub',
      email: 'sub@example.test',
      emailVerified: true,
      displayName: 'sub',
    }),
  };
  const OPERATOR = { authorization: 'Bearer test-token' };
  const post = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...OPERATOR },
    body: '{}',
  };

  const GOOD_GRANT: PermissionGrant = {
    id: 'grant-good',
    rule: 'Bash(gh release edit:*)',
    allows: ['gh release edit'],
    denies: ['gh release edit; rm -rf /'],
    approvalId: 'ap-good',
    answer: '許可します',
    grantedAt: '2026-01-01T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
  };
  const BAD_GRANT_RAW = {
    id: 'grant-bad',
    rule: 'Bash(rm -rf /some/path:*)',
    allows: ['壊れた許可の本文'],
    denies: ['壊れた許可の本文2'],
    approvalId: 'ap-bad',
    answer: '許可します',
    grantedAt: '2026-01-02T00:00:00.000Z',
  };

  const GOOD_ACCOUNT: AuthAccount = {
    id: 'acct-good',
    displayName: 'Good',
    email: 'good@example.test',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: '2026-01-01T00:00:00.000Z',
    grantedBy: 'operator',
  };
  const BAD_ACCOUNT_RAW = {
    id: 'acct-bad',
    email: 'bad@example.test',
    createdAt: '2026-01-02T00:00:00.000Z',
    lastLoginAt: null,
    grantedAt: '2026-01-02T00:00:00.000Z',
    grantedBy: 'operator',
  };

  let root: string;
  let grantsPath: string;
  let authPath: string;
  let stores: ReturnType<typeof createFsStores>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    grantsPath = join(root, 'jobs', 'permission-grants.json');
    authPath = join(root, 'auth', 'auth.json');
    stores = createFsStores(root);
    await stores.permissionGrants.put(GOOD_GRANT);
    await stores.auth.putAccount(GOOD_ACCOUNT);

    const grants = JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
    grants.grants.push(BAD_GRANT_RAW);
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(grantsPath, `${JSON.stringify(grants, null, 2)}\n`);

    const auth = JSON.parse(await readFile(authPath, 'utf8')) as { accounts: unknown[] };
    auth.accounts.push(BAD_ACCOUNT_RAW);
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);

    app = createApp({
      clone: {} as unknown as CloneHost,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      journalEvents: { subscribe: () => () => undefined },
      auth: {
        plan: {
          enabled: true,
          providers: [PROVIDER],
          publicBaseUrl: 'http://127.0.0.1:4517',
          tokenTtlDays: 30,
          description: 'テスト',
        },
        service: createAuthService({
          store: stores.auth,
          providers: createAuthProviderRegistry([PROVIDER]),
        }),
      },
    });
  });

  describe('許可の記録', () => {
    it('読めない行の id は 409（404 ではない）。行は1バイトも変わらず、日誌も残らない', async () => {
      const before = await readFile(grantsPath, 'utf8');

      let status = 0;
      let body: { error: string } | undefined;
      await captureStderr(async () => {
        const response = await app.request('/permission-grants/grant-bad/revoke', post);
        status = response.status;
        body = (await response.json()) as { error: string };
      });

      expect(status).toBe(409);
      expect(body?.error).toContain('grant-bad');
      expect(body?.error).not.toContain('壊れた許可の本文');
      expect(await readFile(grantsPath, 'utf8')).toBe(before);
      expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
    });

    it('ストアは UnreadablePermissionGrantError を投げる（null ではない）', async () => {
      await captureStderr(async () => {
        await expect(
          stores.permissionGrants.revoke('grant-bad', '2026-01-05T00:00:00.000Z'),
        ).rejects.toBeInstanceOf(UnreadablePermissionGrantError);
      });
    });

    it('fail-closed のまま: 取り消しを試みたあとも、読めない行の許可は一覧にも get() にも現れない', async () => {
      await captureStderr(async () => {
        await app.request('/permission-grants/grant-bad/revoke', post);
        expect((await stores.permissionGrants.list()).map((grant) => grant.id)).toEqual([
          'grant-good',
        ]);
        expect(await stores.permissionGrants.get('grant-bad')).toBeNull();
      });
    });

    it('対照: 読める行の取り消しは今までどおり 200（読めない行があっても）', async () => {
      let status = 0;
      await captureStderr(async () => {
        status = (await app.request('/permission-grants/grant-good/revoke', post)).status;
      });
      expect(status).toBe(200);
      const revoked = await stores.permissionGrants.get('grant-good');
      expect(revoked?.revokedAt).toBeDefined();
      const raw = JSON.parse(await readFile(grantsPath, 'utf8')) as { grants: unknown[] };
      expect(raw.grants).toContainEqual(BAD_GRANT_RAW);
    });

    it('対照: 本当に無い id は今までどおり 404', async () => {
      let status = 0;
      await captureStderr(async () => {
        status = (await app.request('/permission-grants/no-such-id/revoke', post)).status;
      });
      expect(status).toBe(404);
    });
  });

  describe('アカウント', () => {
    it('読めない行の id は 409（404 ではない）。行は1バイトも変わらず、日誌も残らない', async () => {
      const before = await readFile(authPath, 'utf8');

      let status = 0;
      let body: { error: string } | undefined;
      await captureStderr(async () => {
        const response = await app.request('/access/acct-bad/revoke', post);
        status = response.status;
        body = (await response.json()) as { error: string };
      });

      expect(status).toBe(409);
      expect(body?.error).toContain('acct-bad');
      expect(body?.error).not.toContain('bad@example.test');
      expect(await readFile(authPath, 'utf8')).toBe(before);
      expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
    });

    it('ストアの revokeAccountAccess は UnreadableAccountError を投げる', async () => {
      await captureStderr(async () => {
        await expect(stores.auth.revokeAccountAccess('acct-bad')).rejects.toBeInstanceOf(
          UnreadableAccountError,
        );
      });
    });

    it('fail-closed のまま: 取り消しを試みたあとも、読めないアカウントは getAccount() / 一覧に現れない', async () => {
      await captureStderr(async () => {
        await app.request('/access/acct-bad/revoke', post);
        expect(await stores.auth.getAccount('acct-bad')).toBeNull();
        expect((await stores.auth.listAccounts()).map((account) => account.id)).toEqual([
          'acct-good',
        ]);
      });
    });

    it('対照: 読める行の取り消しは今までどおり 200（許可が落ちる。読めない行は残る）', async () => {
      let status = 0;
      await captureStderr(async () => {
        status = (await app.request('/access/acct-good/revoke', post)).status;
      });
      expect(status).toBe(200);
      expect((await stores.auth.getAccount('acct-good'))?.grantedAt).toBeNull();
      const raw = JSON.parse(await readFile(authPath, 'utf8')) as { accounts: unknown[] };
      expect(raw.accounts).toContainEqual(BAD_ACCOUNT_RAW);
    });

    it('対照: 本当に無い id は今までどおり 404（ファイルも変わらない）', async () => {
      const before = await readFile(authPath, 'utf8');
      let status = 0;
      await captureStderr(async () => {
        status = (await app.request('/access/no-such-id/revoke', post)).status;
      });
      expect(status).toBe(404);
      expect(await readFile(authPath, 'utf8')).toBe(before);
    });
  });
});
