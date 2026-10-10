import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  type AuthAccount,
  type CloneHost,
  type OAuthProvider,
  type PermissionGrant,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

import { createApp } from './app.js';

const FAKE = 'FAKE_SECRET_VALUE_2536';

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
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...OPERATOR },
  body: JSON.stringify(body),
});

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
const brokenGrant = (id: string) => ({
  id,
  rule: `Bash(echo ${FAKE}:*)`,
  allows: [FAKE],
  denies: [FAKE],
  approvalId: `ap-${id}`,
  answer: FAKE,
  grantedAt: '2026-01-02T00:00:00.000Z',
});
const IDLESS_GRANT_RAW = { rule: FAKE, answer: FAKE };

const GOOD_ACCOUNT: AuthAccount = {
  id: 'acct-good',
  displayName: 'Good',
  email: 'good@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  grantedAt: '2026-01-01T00:00:00.000Z',
  grantedBy: 'operator',
};
const brokenAccount = (id: string) => ({
  id,
  email: `${FAKE}@example.test`,
  createdAt: '2026-01-02T00:00:00.000Z',
  lastLoginAt: null,
  grantedAt: '2026-01-02T00:00:00.000Z',
  grantedBy: 'operator',
});
const IDLESS_ACCOUNT_RAW = { email: `${FAKE}@example.test` };

type Stores = ReturnType<typeof createFsStores>;

function appFor(stores: Stores) {
  return createApp({
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
}

async function getJson(
  app: ReturnType<typeof createApp>,
  path: string,
): Promise<{ text: string; body: Record<string, unknown> }> {
  let text = '';
  await captureStderr(async () => {
    const response = await app.request(path, { headers: OPERATOR });
    expect(response.status).toBe(200);
    text = await response.text();
  });
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

describe('読めない行の id を返す一覧（fs。issue #2536）', () => {
  let root: string;
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  const grantsFile = () => join(root, 'jobs', 'permission-grants.json');
  const authFile = () => join(root, 'auth', 'auth.json');

  async function appendRaw(
    file: string,
    key: 'grants' | 'accounts',
    ...rows: unknown[]
  ): Promise<void> {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown[]>;
    (raw[key] as unknown[]).push(...rows);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
  }

  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  async function setup(): Promise<void> {
    root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
    await stores.permissionGrants.put(GOOD_GRANT);
    await stores.auth.putAccount(GOOD_ACCOUNT);
    app = appFor(stores);
  }

  describe('GET /permission-grants', () => {
    it('読めない行が無ければ、rowsUnreadable の鍵ごと無い（{ count: 0 } を作らない）', async () => {
      await setup();
      const { body, text } = await getJson(app, '/permission-grants');
      expect('rowsUnreadable' in body).toBe(false);
      expect(text).not.toContain('rowsUnreadable');
      expect(body.grants).toHaveLength(1);
    });

    it('読めない行が在れば、件数と id・不正な欄名だけを載せる。本文は載らない。id の無い行は件数だけ', async () => {
      await setup();
      await appendRaw(
        grantsFile(),
        'grants',
        brokenGrant('grant-bad'),
        brokenGrant('grant-bad-2'),
        IDLESS_GRANT_RAW,
      );
      const { body, text } = await getJson(app, '/permission-grants');
      expect(body.rowsUnreadable).toEqual({
        count: 3,
        rows: [
          { id: 'grant-bad', reason: '不正な欄: route' },
          { id: 'grant-bad-2', reason: '不正な欄: route' },
        ],
      });
      expect(body.grants).toEqual([GOOD_GRANT]);
      expect(text).not.toContain(FAKE);
      expect(text).not.toContain('allows":["FAKE');
    });

    it('読めない行しか無い一覧は、grants が空でも rowsUnreadable で言い分けられる', async () => {
      await setup();
      await stores.permissionGrants.removeUnreadable([]);
      await writeFile(
        grantsFile(),
        `${JSON.stringify({ grants: [brokenGrant('grant-only-bad')] })}\n`,
      );
      const { body } = await getJson(app, '/permission-grants');
      expect(body.grants).toEqual([]);
      expect(body.rowsUnreadable).toEqual({
        count: 1,
        rows: [{ id: 'grant-only-bad', reason: '不正な欄: route' }],
      });
    });

    it('rows[].id をそのまま消す口へ渡せる。消したら鍵が無くなる。404 の文は一覧を案内する', async () => {
      await setup();
      await appendRaw(grantsFile(), 'grants', brokenGrant('grant-bad'));
      const first = await getJson(app, '/permission-grants');
      const rows = (first.body.rowsUnreadable as { rows: { id: string }[] }).rows;

      let missing = { status: 0, text: '' };
      await captureStderr(async () => {
        const response = await app.request(
          '/permission-grants/unreadable/remove',
          post({ ids: ['no-such-id'] }),
        );
        missing = { status: response.status, text: await response.text() };
      });
      expect(missing.status).toBe(404);
      expect(missing.text).toContain('rowsUnreadable.rows[].id');
      expect(missing.text).not.toContain('stderr');

      await captureStderr(async () => {
        const response = await app.request(
          '/permission-grants/unreadable/remove',
          post({ ids: rows.map((row) => row.id) }),
        );
        expect(response.status).toBe(200);
      });
      const after = await getJson(app, '/permission-grants');
      expect('rowsUnreadable' in after.body).toBe(false);
    });
  });

  describe('GET /access', () => {
    it('読めない行が無ければ、rowsUnreadable の鍵ごと無い', async () => {
      await setup();
      const { body, text } = await getJson(app, '/access');
      expect('rowsUnreadable' in body).toBe(false);
      expect(text).not.toContain('rowsUnreadable');
      expect(body.accounts).toHaveLength(1);
    });

    it('読めない行が在れば、件数と id・不正な欄名だけを載せる。email などは載らない。id の無い行は件数だけ', async () => {
      await setup();
      await appendRaw(
        authFile(),
        'accounts',
        brokenAccount('acct-bad'),
        brokenAccount('acct-bad-2'),
        IDLESS_ACCOUNT_RAW,
      );
      const { body, text } = await getJson(app, '/access');
      expect(body.rowsUnreadable).toEqual({
        count: 3,
        rows: [
          { id: 'acct-bad', reason: '不正な欄: displayName' },
          { id: 'acct-bad-2', reason: '不正な欄: displayName' },
        ],
      });
      expect((body.accounts as { id: string }[]).map((account) => account.id)).toEqual([
        'acct-good',
      ]);
      expect(text).not.toContain(FAKE);
    });

    it('rows[].id をそのまま消す口へ渡せる。404 の文は一覧を案内する', async () => {
      await setup();
      await appendRaw(authFile(), 'accounts', brokenAccount('acct-bad'));
      let missing = { status: 0, text: '' };
      await captureStderr(async () => {
        const response = await app.request(
          '/access/unreadable/remove',
          post({ ids: ['no-such-id'] }),
        );
        missing = { status: response.status, text: await response.text() };
      });
      expect(missing.status).toBe(404);
      expect(missing.text).toContain('rowsUnreadable.rows[].id');
      expect(missing.text).not.toContain('stderr');

      await captureStderr(async () => {
        const response = await app.request(
          '/access/unreadable/remove',
          post({ ids: ['acct-bad'] }),
        );
        expect(response.status).toBe(200);
      });
      const after = await getJson(app, '/access');
      expect('rowsUnreadable' in after.body).toBe(false);
    });
  });

  describe('ストア単位（listUnreadable / listUnreadableAccounts）', () => {
    it('fs の許可: 本文を含まない id と reason だけを返す。id の無い行は id を持たない', async () => {
      await setup();
      await appendRaw(grantsFile(), 'grants', brokenGrant('grant-bad'), IDLESS_GRANT_RAW);
      let rows: Awaited<ReturnType<typeof stores.permissionGrants.listUnreadable>> = [];
      await captureStderr(async () => {
        rows = await stores.permissionGrants.listUnreadable();
      });
      expect(rows).toEqual([
        { id: 'grant-bad', reason: '不正な欄: route' },
        { reason: expect.any(String) as string },
      ]);
      expect(JSON.stringify(rows)).not.toContain(FAKE);
    });

    it('fs のアカウント: 中身を含まない id と reason だけを返す', async () => {
      await setup();
      await appendRaw(authFile(), 'accounts', brokenAccount('acct-bad'), IDLESS_ACCOUNT_RAW);
      let rows: Awaited<ReturnType<typeof stores.auth.listUnreadableAccounts>> = [];
      await captureStderr(async () => {
        rows = await stores.auth.listUnreadableAccounts();
      });
      expect(rows).toEqual([
        { id: 'acct-bad', reason: '不正な欄: displayName' },
        { reason: expect.any(String) as string },
      ]);
      expect(JSON.stringify(rows)).not.toContain(FAKE);
    });

    it('メモリは常に空（許可もアカウントも）', async () => {
      const memory = createMemoryStores();
      expect(await memory.permissionGrants.listUnreadable()).toEqual([]);
      expect(await memory.auth.listUnreadableAccounts()).toEqual([]);
    });
  });
});

describe('読めない行の id を返す一覧（pg / PGlite。issue #2536）', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  async function setupPg() {
    const { client, db } = await createMigratedPglite();
    close = () => client.close();
    const stores = createPgStoresFromDb(db) as unknown as Stores;
    await stores.permissionGrants.put(GOOD_GRANT);
    await stores.auth.putAccount(GOOD_ACCOUNT);
    return { db, stores, app: appFor(stores) };
  }

  async function insertBrokenGrant(db: Awaited<ReturnType<typeof setupPg>>['db'], id: string) {
    await db.insert(tables.permissionGrants).values({
      id,
      grantedAt: new Date('2026-01-02T00:00:00.000Z'),
      revokedAt: null,
      record: brokenGrant(id) as unknown as Record<string, unknown>,
    });
  }

  it('許可: 読めない行が無ければ鍵ごと無い', async () => {
    const { app } = await setupPg();
    const { body } = await getJson(app, '/permission-grants');
    expect('rowsUnreadable' in body).toBe(false);
  });

  it('許可: 合わない record の id と不正な欄名だけを載せる。本文は載らない', async () => {
    const { app, db } = await setupPg();
    await captureStderr(async () => {
      await insertBrokenGrant(db, 'grant-bad');
      await insertBrokenGrant(db, 'grant-bad-2');
    });
    const { body, text } = await getJson(app, '/permission-grants');
    expect(body.rowsUnreadable).toEqual({
      count: 2,
      rows: [
        { id: 'grant-bad', reason: '不正な欄: route' },
        { id: 'grant-bad-2', reason: '不正な欄: route' },
      ],
    });
    expect(body.grants).toEqual([GOOD_GRANT]);
    expect(text).not.toContain(FAKE);
  });

  it('アカウント: 読めない行を持てないので、鍵は常に無い', async () => {
    const { app, stores } = await setupPg();
    expect(await stores.auth.listUnreadableAccounts()).toEqual([]);
    const { body } = await getJson(app, '/access');
    expect('rowsUnreadable' in body).toBe(false);
  });
});
