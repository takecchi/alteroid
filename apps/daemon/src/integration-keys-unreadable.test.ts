import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  type CloneHost,
  type IntegrationKeyRecord,
} from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

const FAKE = 'FAKE_SECRET_VALUE_3216';
const OPERATOR = { authorization: 'Bearer test-token' };
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...OPERATOR },
  body: JSON.stringify(body),
});

const GOOD: IntegrationKeyRecord = {
  id: 'key-good',
  name: 'ci',
  source: 'ci.main',
  sha256: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'operator',
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  maxBodyBytes: null,
  ratePerMinute: null,
};
const BAD = { ...GOOD, id: 'key-bad', name: FAKE, source: 'BAD SOURCE', sha256: 'b'.repeat(64) };
const BAD2 = { ...BAD, id: 'key-bad-2', sha256: 'c'.repeat(64) };
const IDLESS = { name: FAKE, source: 'BAD SOURCE' };

type Stores = ReturnType<typeof createFsStores>;

describe('読めない連携の鍵の行（fs。issue #3216）', () => {
  let root: string;
  let stores: Stores;
  let app: ReturnType<typeof createApp>;
  const file = () => join(root, 'auth', 'integration-keys.json');
  const makeApp = (override: Partial<Stores> = {}) =>
    createApp({
      clone: {} as unknown as CloneHost,
      stores: { ...stores, ...override },
      token: 'test-token',
      shutdown: () => undefined,
      journalEvents: { subscribe: () => () => undefined },
      auth: {
        plan: {
          enabled: true,
          providers: [],
          publicBaseUrl: 'http://127.0.0.1:4517',
          tokenTtlDays: 30,
          description: 'テスト',
        },
        service: createAuthService({
          store: stores.auth,
          providers: createAuthProviderRegistry([]),
        }),
      },
    });
  const rawRows = async () =>
    (JSON.parse(await readFile(file(), 'utf8')) as { keys: unknown[] }).keys;

  async function call(path: string, init: RequestInit): Promise<{ status: number; text: string }> {
    let result = { status: 0, text: '' };
    await captureStderr(async () => {
      const response = await app.request(path, init);
      result = { status: response.status, text: await response.text() };
    });
    return result;
  }

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
    await stores.integrationKeys.putIntegrationKey(GOOD);
    const raw = JSON.parse(await readFile(file(), 'utf8')) as { keys: unknown[] };
    raw.keys.push(BAD, BAD2, IDLESS);
    await mkdir(join(root, 'auth'), { recursive: true });
    await writeFile(file(), `${JSON.stringify(raw, null, 2)}\n`);
    app = makeApp();
  });

  it('GET /integration-keys: 読めない行が在れば rowsUnreadable（件数と id・不正な欄名。中身は出ない）', async () => {
    const { status, text } = await call('/integration-keys', { headers: OPERATOR });
    expect(status).toBe(200);
    const body = JSON.parse(text) as {
      keys: { id: string }[];
      rowsUnreadable?: { count: number; rows: { id: string; reason: string }[] };
    };
    expect(body.keys.map((key) => key.id)).toEqual(['key-good']);
    expect(body.rowsUnreadable?.count).toBe(3);
    expect(body.rowsUnreadable?.rows).toEqual([
      { id: 'key-bad', reason: '不正な欄: source' },
      { id: 'key-bad-2', reason: '不正な欄: source' },
    ]);
    expect(text).not.toContain(FAKE);
  });

  it('GET /integration-keys: 読めない行が無ければ rowsUnreadable の鍵ごと無い', async () => {
    const clean = createFsStores(await makeTempDir('alteroid-test-'));
    await clean.integrationKeys.putIntegrationKey(GOOD);
    stores = clean;
    app = makeApp();
    const { status, text } = await call('/integration-keys', { headers: OPERATOR });
    expect(status).toBe(200);
    expect(JSON.parse(text)).not.toHaveProperty('rowsUnreadable');
  });

  it('指した読めない行だけが消える。読める行・指していない行は残り、応答に中身は出ない', async () => {
    const { status, text } = await call(
      '/integration-keys/unreadable/remove',
      post({ ids: ['key-bad'] }),
    );
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ removedIds: ['key-bad'], count: 1 });
    expect(text).not.toContain(FAKE);
    const rows = await rawRows();
    expect(rows).not.toContainEqual(BAD);
    expect(rows).toContainEqual(BAD2);
    expect(rows).toContainEqual(IDLESS);
    expect(await stores.integrationKeys.getIntegrationKey('key-good')).not.toBeNull();
  });

  it('日誌が先: 消す前に日誌が書かれ、日誌は id と件数だけ（中身は無い）', async () => {
    const seen: { rowStillThere?: boolean } = {};
    const journal = {
      ...stores.journal,
      append: async (entry: Parameters<Stores['journal']['append']>[0]) => {
        seen.rowStillThere = (await rawRows()).some(
          (row) => (row as { id?: string }).id === 'key-bad',
        );
        return stores.journal.append(entry);
      },
    };
    app = makeApp({ journal });
    const { status } = await call(
      '/integration-keys/unreadable/remove',
      post({ ids: ['key-bad'] }),
    );
    expect(status).toBe(200);
    expect(seen.rowStillThere).toBe(true);
    const written = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(written).toContain('key-bad');
    expect(written).toContain('1 件');
    expect(written).toContain('POST /integration-keys/unreadable/remove');
    expect(written).not.toContain(FAKE);
  });

  it('日誌が書けなければ 500。ファイルは1バイトも変わらない', async () => {
    app = makeApp({
      journal: {
        ...stores.journal,
        append: async () => {
          throw new Error(`journal down ${FAKE}`);
        },
      },
    });
    const before = await readFile(file(), 'utf8');
    const { status, text } = await call(
      '/integration-keys/unreadable/remove',
      post({ ids: ['key-bad'] }),
    );
    expect(status).toBe(500);
    expect(text).not.toContain(FAKE);
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('知らない id・読める行の id が1つでもあれば 404。何も消さず日誌も書かず、指された文字列を映さない', async () => {
    const before = await readFile(file(), 'utf8');
    for (const typed of [`${FAKE}-typo`, 'key-good']) {
      const { status, text } = await call(
        '/integration-keys/unreadable/remove',
        post({ ids: ['key-bad', typed] }),
      );
      expect(status).toBe(404);
      expect(text).not.toContain(typed);
    }
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
  });

  it('入力の形が不正（空配列・空文字・配列でない）は 400。何も消さない', async () => {
    const before = await readFile(file(), 'utf8');
    for (const body of [{ ids: [] }, { ids: [''] }, { ids: 'key-bad' }, {}]) {
      expect((await call('/integration-keys/unreadable/remove', post(body))).status).toBe(400);
    }
    expect(await readFile(file(), 'utf8')).toBe(before);
  });

  it('資格が無ければ 401', async () => {
    const { status } = await call('/integration-keys/unreadable/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['key-bad'] }),
    });
    expect(status).toBe(401);
  });

  it('読めない行の失効は 409 で言い分け、消す口を添える（無い id は 404 のまま）', async () => {
    const unreadable = await call('/integration-keys/key-bad/revoke', post({}));
    expect(unreadable.status).toBe(409);
    expect(unreadable.text).toContain('POST /integration-keys/unreadable/remove');
    expect(unreadable.text).not.toContain(FAKE);
    expect((await call('/integration-keys/nothing/revoke', post({}))).status).toBe(404);
  });
});
