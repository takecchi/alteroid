import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// 雛形を前払いする: 最初の `beforeEach`（hookTimeout 10s）で WASM の起動 + migrate を払わせないため。
beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

const BAD_ID = 'bad-commitment';
const BAD_BODY = '壊れた約束の本文（跡に出てはいけない）';
const BAD_AT = '2026-09-02T00:00:00.000Z';

async function fsStoresWithBadRow(): Promise<Stores> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.commitments.open({
    id: 'good-commitment',
    at: BAD_AT,
    origin: 'self',
    body: '正常な約束',
  });
  const commitmentsPath = join(root, 'jobs', 'commitments.json');
  const raw = JSON.parse(await readFile(commitmentsPath, 'utf8')) as { commitments: unknown[] };
  raw.commitments.push({
    id: BAD_ID,
    at: BAD_AT,
    origin: 'bogus',
    body: BAD_BODY,
  });
  await writeFile(commitmentsPath, JSON.stringify(raw, null, 2), 'utf8');
  return stores;
}

async function pgStoresWithBadRow(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  await stores.commitments.open({
    id: 'good-commitment',
    at: BAD_AT,
    origin: 'self',
    body: '正常な約束',
  });
  await db.insert(tables.commitments).values({
    id: BAD_ID,
    at: new Date(BAD_AT),
    closedAt: null,
    commitment: { id: BAD_ID, at: BAD_AT, origin: 'bogus', body: BAD_BODY },
  });
  return stores;
}

describe.each([
  ['fs', fsStoresWithBadRow],
  ['pg', pgStoresWithBadRow],
] as const)('読めない約束を読む口（%s 実装。issue #2148）', (_label, makeStores) => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    stores = await makeStores();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
  });

  // 台帳へ書く口は無い（段2b）ので、読めない約束は読む口でだけ見える: 「片付いた」ではなく読めない行として、本文は漏らさずに
  it('GET /commitments は読めない約束を unreadable に載せる（entries には出ない・本文は漏れない）', async () => {
    const list = await app.request('/commitments');
    const listBody = (await list.json()) as {
      entries: { id: string }[];
      unreadable: { id?: string }[];
    };
    expect(listBody.unreadable.map((row) => row.id)).toContain(BAD_ID);
    expect(listBody.entries.map((entry) => entry.id)).not.toContain(BAD_ID);
    expect(JSON.stringify(listBody)).not.toContain(BAD_BODY);
  });

  it('GET /commitments/:id は読めない約束で 409（本文は漏れない）', async () => {
    const response = await app.request(`/commitments/${BAD_ID}`);
    const body = (await response.json()) as { error: string };
    expect(response.status, `本文: ${JSON.stringify(body)}`).toBe(409);
    expect(body.error).not.toContain(BAD_BODY);
  });

  it('GET /commitments/:id は本当に無い id で 404', async () => {
    const response = await app.request('/commitments/never-existed');
    expect(response.status).toBe(404);
  });
});
