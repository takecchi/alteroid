import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CloneHost, Stores } from '@alteroid/core';
import { createCloneTools } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// 雛形は前払いする: 最初の `beforeEach`（hookTimeout 10s）で WASM の起動 + migrate を払わせないため。
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

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const BAD_SLUG = 'bad-practice';
const BAD_TITLE = '壊れたやり方（跡に出てはいけない）';
const BAD_CONTENT = '壊れた本文（跡に出てはいけない）';

// `kind = 'bogus'` ではなく空文字列にする: `practiceKindSchema` は enum ではない自由文字列で、「決められた一覧に無い値」は検査を通ってしまうため。
async function fsStoresWithBadRow(): Promise<Stores> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.practices.write({
    slug: 'good-practice',
    kind: '実装',
    title: '正常なやり方',
    content: '正常な本文',
  });
  const practicesPath = join(root, 'jobs', 'practices.json');
  const raw = JSON.parse(await readFile(practicesPath, 'utf8')) as { practices: unknown[] };
  raw.practices.push({
    slug: BAD_SLUG,
    kind: '',
    title: BAD_TITLE,
    content: BAD_CONTENT,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  });
  await writeFile(practicesPath, JSON.stringify(raw, null, 2), 'utf8');
  return stores;
}

async function pgStoresWithBadRow(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  await stores.practices.write({
    slug: 'good-practice',
    kind: '実装',
    title: '正常なやり方',
    content: '正常な本文',
  });
  await db.insert(tables.practices).values({
    slug: BAD_SLUG,
    kind: '',
    title: BAD_TITLE,
    content: BAD_CONTENT,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  });
  return stores;
}

function toolCaller(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    const result = await found.handler(args as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

describe.each([
  ['fs', fsStoresWithBadRow],
  ['pg', pgStoresWithBadRow],
] as const)(
  'practices の壊れた行を4つの口で書き直す・外す（%s 実装。issue #2011）',
  (_label, makeStores) => {
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

    it('PUT /practices/:slug は壊れた行があっても書き直せる（直す前は read() の throw で 500）', async () => {
      const put = await app.request(`/practices/${BAD_SLUG}`, {
        ...json({ kind: '調査', title: '直した題', content: '直した本文' }),
        method: 'PUT',
      });
      const body = (await put.json().catch(() => undefined)) as unknown;
      expect(put.status, `本文: ${JSON.stringify(body)}`).toBe(200);

      const read = await app.request(`/practices/${BAD_SLUG}`);
      expect(read.status).toBe(200);
      const readBody = (await read.json()) as { practice: { title: string } };
      expect(readBody.practice.title).toBe('直した題');

      const entries = await stores.journal.list({ types: ['decision'] });
      expect(entries[0]).toMatchObject({
        decision: expect.stringContaining('読めない形で入っていた') as unknown as string,
      });
      const joined = entries.map((entry) => JSON.stringify(entry)).join('');
      expect(joined).not.toContain(BAD_TITLE);
      expect(joined).not.toContain(BAD_CONTENT);
    });

    it('DELETE /practices/:slug は壊れた行があっても消せる（直す前は read() の throw で 500）', async () => {
      const del = await app.request(`/practices/${BAD_SLUG}`, { method: 'DELETE' });
      const body = (await del.json().catch(() => undefined)) as unknown;
      expect(del.status, `本文: ${JSON.stringify(body)}`).toBe(200);

      expect(body).toEqual({ ok: true, slug: BAD_SLUG });

      const read = await app.request(`/practices/${BAD_SLUG}`);
      expect(read.status).toBe(404);

      const entries = await stores.journal.list({ types: ['decision'] });
      expect(entries[0]).toMatchObject({
        decision: expect.stringContaining('読めない形で入っていた') as unknown as string,
      });
      const joined = entries.map((entry) => JSON.stringify(entry)).join('');
      expect(joined).not.toContain(BAD_TITLE);
      expect(joined).not.toContain(BAD_CONTENT);
    });

    it('DELETE /practices/:slug は本当に無い slug なら今までどおり 404', async () => {
      const del = await app.request('/practices/never-existed', { method: 'DELETE' });
      expect(del.status).toBe(404);
    });

    it('GET /practices/:slug は壊れた行があると 409 を返し、本文（title/content）は応答に載らない', async () => {
      const get = await app.request(`/practices/${BAD_SLUG}`);
      const body = (await get.json().catch(() => undefined)) as unknown;
      expect(get.status, `本文: ${JSON.stringify(body)}`).toBe(409);
      const joined = JSON.stringify(body);
      expect(joined).not.toContain(BAD_TITLE);
      expect(joined).not.toContain(BAD_CONTENT);
    });

    it('GET /practices/:slug は本当に無い slug なら今までどおり 404（409 との対照）', async () => {
      const get = await app.request('/practices/never-existed');
      expect(get.status).toBe(404);
    });

    it('practice_write は壊れた行があっても書き直せる（直す前は read() の throw で例外）', async () => {
      const call = toolCaller(stores);
      const result = await call('practice_write', {
        slug: BAD_SLUG,
        kind: '調査',
        title: '直した題',
        content: '直した本文',
      });
      expect(result).toContain('読めない形で入っていたやり方を');
      expect(result).toContain('書き直した');

      const read = await stores.practices.read(BAD_SLUG);
      expect(read?.title).toBe('直した題');
    });

    it('practice_remove は壊れた行があっても消せる（直す前は read() の throw で例外）', async () => {
      const call = toolCaller(stores);
      const result = await call('practice_remove', { slug: BAD_SLUG });
      expect(result).toContain('読めない形で入っていたやり方');
      expect(result).toContain('消した');

      expect(await stores.practices.read(BAD_SLUG)).toBeNull();
    });

    it('practice_remove は本当に無い slug なら今までどおり「無かった」', async () => {
      const call = toolCaller(stores);
      const result = await call('practice_remove', { slug: 'never-existed' });
      expect(result).toContain('もともと無かった');
    });
  },
);
