import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  type AuthAccount,
  type CloneHost,
  type OAuthProvider,
  type PermissionGrant,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

/**
 * issue #2440。読めない許可の行（`permission-grants.json` の `invalidGrantsRaw`）と読めない
 * アカウントの行（`auth.json` の `invalidAccountsRaw`）を、id を指して消す口
 * （`POST /permission-grants/unreadable/remove` / `POST /access/unreadable/remove`）。
 * トークンの `POST /tokens/unreadable/remove`（#2354）と同じ約束を、偽の値で測る。
 *
 * - 消える（指した読めない行だけ。読める行は残る）。
 * - 日誌が先（消す前の時点で日誌が書かれている）。日誌が書けなければ 500 で、ファイルは不変。
 * - 読めない行に無い id が1つでもあれば 404 で何も消さず、日誌も書かない。応答に入力を映さない。
 * - 日誌に行の中身を書かない（id と件数だけ）。
 */
const FAKE = 'FAKE_SECRET_VALUE_2440';

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
// route（必須欄）が無い。本文には偽の値を入れる。
const BAD_GRANT_RAW = {
  id: 'grant-bad',
  rule: `Bash(echo ${FAKE}:*)`,
  allows: [FAKE],
  denies: [FAKE],
  approvalId: 'ap-bad',
  answer: FAKE,
  grantedAt: '2026-01-02T00:00:00.000Z',
};
const BAD_GRANT_RAW_2 = { ...BAD_GRANT_RAW, id: 'grant-bad-2' };
// id が取れない読めない行。
const IDLESS_GRANT_RAW = { rule: FAKE, answer: FAKE };

const GOOD_ACCOUNT: AuthAccount = {
  id: 'acct-good',
  displayName: 'Good',
  email: 'good@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  grantedAt: '2026-01-01T00:00:00.000Z',
  grantedBy: 'operator',
  ownerDeclaredAt: null,
};
// displayName（必須欄）が無い。email に偽の値を入れる。
const BAD_ACCOUNT_RAW = {
  id: 'acct-bad',
  email: `${FAKE}@example.test`,
  createdAt: '2026-01-02T00:00:00.000Z',
  lastLoginAt: null,
  grantedAt: '2026-01-02T00:00:00.000Z',
  grantedBy: 'operator',
  ownerDeclaredAt: null,
};
const BAD_ACCOUNT_RAW_2 = { ...BAD_ACCOUNT_RAW, id: 'acct-bad-2' };
const IDLESS_ACCOUNT_RAW = { email: `${FAKE}@example.test` };

type Stores = ReturnType<typeof createFsStores>;

interface Target {
  name: string;
  path: string;
  /** ファイルの配列のキー。 */
  key: 'grants' | 'accounts';
  file: () => string;
  good: unknown;
  bad: unknown;
  bad2: unknown;
  idless: unknown;
  goodId: string;
  badId: string;
  bad2Id: string;
  /** 読める行がまだ読めるか。 */
  stillReadable: (stores: Stores) => Promise<boolean>;
}

describe('読めない行を id で消す口（fs。issue #2440）', () => {
  let root: string;
  let stores: Stores;
  let makeApp: (override?: Partial<Stores>) => ReturnType<typeof createApp>;
  let app: ReturnType<typeof createApp>;

  const targets: Target[] = [
    {
      name: '許可の記録',
      path: '/permission-grants/unreadable/remove',
      key: 'grants',
      file: () => join(root, 'jobs', 'permission-grants.json'),
      good: GOOD_GRANT,
      bad: BAD_GRANT_RAW,
      bad2: BAD_GRANT_RAW_2,
      idless: IDLESS_GRANT_RAW,
      goodId: 'grant-good',
      badId: 'grant-bad',
      bad2Id: 'grant-bad-2',
      stillReadable: async (s) => (await s.permissionGrants.get('grant-good')) !== null,
    },
    {
      name: 'アカウント',
      path: '/access/unreadable/remove',
      key: 'accounts',
      file: () => join(root, 'auth', 'auth.json'),
      good: GOOD_ACCOUNT,
      bad: BAD_ACCOUNT_RAW,
      bad2: BAD_ACCOUNT_RAW_2,
      idless: IDLESS_ACCOUNT_RAW,
      goodId: 'acct-good',
      badId: 'acct-bad',
      bad2Id: 'acct-bad-2',
      stillReadable: async (s) => (await s.auth.getAccount('acct-good')) !== null,
    },
  ];

  async function appendRaw(target: Target, ...rows: unknown[]): Promise<void> {
    const raw = JSON.parse(await readFile(target.file(), 'utf8')) as Record<string, unknown[]>;
    (raw[target.key] as unknown[]).push(...rows);
    await mkdir(join(target.file(), '..'), { recursive: true });
    await writeFile(target.file(), `${JSON.stringify(raw, null, 2)}\n`);
  }

  async function rawRows(target: Target): Promise<unknown[]> {
    const raw = JSON.parse(await readFile(target.file(), 'utf8')) as Record<string, unknown[]>;
    return raw[target.key] as unknown[];
  }

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
    await stores.permissionGrants.put(GOOD_GRANT);
    await stores.auth.putAccount(GOOD_ACCOUNT);
    for (const target of targets) await appendRaw(target, target.bad, target.bad2, target.idless);

    makeApp = (override = {}) =>
      createApp({
        clone: {} as unknown as CloneHost,
        stores: { ...stores, ...override },
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
            store: (override.auth ?? stores.auth) as Stores['auth'],
            providers: createAuthProviderRegistry([PROVIDER]),
          }),
        },
      });
    app = makeApp();
  });

  describe.each(targets)('$name（POST $path）', (target) => {
    async function call(body: unknown): Promise<{ status: number; text: string }> {
      let result = { status: 0, text: '' };
      await captureStderr(async () => {
        const response = await app.request(target.path, post(body));
        result = { status: response.status, text: await response.text() };
      });
      return result;
    }

    it('指した読めない行だけが消える。読める行・指していない読めない行は残る。応答に行の中身は出ない', async () => {
      const { status, text } = await call({ ids: [target.badId] });

      expect(status).toBe(200);
      expect(JSON.parse(text)).toEqual({ removedIds: [target.badId], count: 1 });
      expect(text).not.toContain(FAKE);
      const rows = await rawRows(target);
      expect(rows).not.toContainEqual(target.bad);
      expect(rows).toContainEqual(target.bad2);
      expect(rows).toContainEqual(target.idless);
      expect(rows).toContainEqual(expect.objectContaining({ id: target.goodId }));
      expect(await target.stillReadable(stores)).toBe(true);
    });

    it('複数の id と重複する id を1回で消す（重複は1件に数える）', async () => {
      const { status, text } = await call({ ids: [target.badId, target.bad2Id, target.badId] });
      expect(status).toBe(200);
      expect(JSON.parse(text)).toEqual({ removedIds: [target.badId, target.bad2Id], count: 2 });
      const rows = await rawRows(target);
      expect(rows).not.toContainEqual(target.bad);
      expect(rows).not.toContainEqual(target.bad2);
      expect(rows).toContainEqual(target.idless);
    });

    it('日誌が先: 消す前の時点で日誌が書かれている。日誌には id と件数だけで、行の中身は無い', async () => {
      const seenAtAppend: { rowsStillThere?: boolean; entry?: unknown } = {};
      const journal = {
        ...stores.journal,
        append: async (entry: Parameters<Stores['journal']['append']>[0]) => {
          seenAtAppend.rowsStillThere = (await rawRows(target)).some(
            (row) => (row as { id?: string }).id === target.badId,
          );
          seenAtAppend.entry = entry;
          return stores.journal.append(entry);
        },
      };
      app = makeApp({ journal });

      const { status } = await call({ ids: [target.badId] });

      expect(status).toBe(200);
      expect(seenAtAppend.rowsStillThere).toBe(true);
      const written = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
      expect(written).toContain(target.badId);
      expect(written).toContain('1 件');
      expect(written).not.toContain(FAKE);
    });

    it('日誌が書けなければ 500。状態は変わらず（ファイルは1バイトも）、応答に原因の本文は出ない', async () => {
      const journal = {
        ...stores.journal,
        append: async () => {
          throw new Error(`journal down ${FAKE}`);
        },
      };
      app = makeApp({ journal });
      const before = await readFile(target.file(), 'utf8');

      const { status, text } = await call({ ids: [target.badId] });

      expect(status).toBe(500);
      expect(text).not.toContain(FAKE);
      expect(await readFile(target.file(), 'utf8')).toBe(before);
    });

    it('知らない id が1つでもあれば 404。何も消さず、日誌も書かず、応答に指された文字列を映さない', async () => {
      const before = await readFile(target.file(), 'utf8');
      const typed = `${FAKE}-typo`;

      const { status, text } = await call({ ids: [target.badId, typed] });

      expect(status).toBe(404);
      expect(text).not.toContain(typed);
      expect(text).not.toContain(FAKE);
      expect(text).not.toContain(target.badId);
      expect(await readFile(target.file(), 'utf8')).toBe(before);
      expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
    });

    it('読める行の id を指しても 404（読める行は消せない。不変）', async () => {
      const before = await readFile(target.file(), 'utf8');
      const { status } = await call({ ids: [target.goodId] });
      expect(status).toBe(404);
      expect(await readFile(target.file(), 'utf8')).toBe(before);
      expect(await target.stillReadable(stores)).toBe(true);
    });

    it('id が取れない行はこの口では消せない（どの id を指しても残る）', async () => {
      await call({ ids: [target.badId, target.bad2Id] });
      expect(await rawRows(target)).toContainEqual(target.idless);
    });

    it('消せなかった（状態の変更が失敗した）ときは、打ち消しの日誌を足して 500。原因の本文は出ない', async () => {
      const failing = {
        removeUnreadable: async (
          _ids: readonly string[],
          options?: { beforeRemove?: (ids: readonly string[]) => Promise<void> },
        ) => {
          await options?.beforeRemove?.([target.badId]);
          throw new Error(`disk ${FAKE}`);
        },
      };
      app =
        target.key === 'grants'
          ? makeApp({ permissionGrants: { ...stores.permissionGrants, ...failing } })
          : makeApp({
              auth: {
                ...stores.auth,
                removeUnreadableAccounts: failing.removeUnreadable,
              } as Stores['auth'],
            });

      const { status, text } = await call({ ids: [target.badId] });

      expect(status).toBe(500);
      expect(text).not.toContain(FAKE);
      const written = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
      expect(written).toContain('消せなかった');
      expect(written).not.toContain(FAKE);
    });

    it('入力の形が不正（空配列・空文字・配列でない）は 400。何も消さない', async () => {
      const before = await readFile(target.file(), 'utf8');
      for (const body of [{ ids: [] }, { ids: [''] }, { ids: target.badId }, {}]) {
        expect((await call(body)).status).toBe(400);
      }
      expect(await readFile(target.file(), 'utf8')).toBe(before);
    });

    it('資格が無ければ 401', async () => {
      const response = await app.request(target.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [target.badId] }),
      });
      expect(response.status).toBe(401);
    });
  });

  it('取り消しの 409 の文に、消す口を添える', async () => {
    let grant = '';
    let account = '';
    await captureStderr(async () => {
      const g = await app.request('/permission-grants/grant-bad/revoke', post({}));
      expect(g.status).toBe(409);
      grant = ((await g.json()) as { error: string }).error;
      const a = await app.request('/access/acct-bad/revoke', post({}));
      expect(a.status).toBe(409);
      account = ((await a.json()) as { error: string }).error;
    });
    expect(grant).toContain('POST /permission-grants/unreadable/remove');
    expect(account).toContain('POST /access/unreadable/remove');
    expect(grant).not.toContain(FAKE);
    expect(account).not.toContain(FAKE);
  });
});
