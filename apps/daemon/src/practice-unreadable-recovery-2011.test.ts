import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CloneHost, Stores } from '@alteroid/core';
import { createCloneTools } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #2011（マネージャー指摘によるフォローアップ）。
 *
 * `PgPracticeStore.read()` / `FsPracticeStore.read()` が読めない行で
 * `UnreadablePracticeError` を投げるようになったこと自体は issue #2011 の
 * 直しだが、**`PUT`/`DELETE /practices/:slug`（`apps/daemon/src/app.ts`）と
 * `practice_write`/`practice_remove`（`packages/core/src/tools.ts`）は
 * `read()` を「無いかどうか」の判定にしか使っておらず、投げっぱなしにすると
 * `write()` / `remove()` まで届かなくなる**——壊れた行を直す・消すための
 * 唯一の入口（CLI・Web UI は HTTP、クローンは MCP 道具。3入口とも束ねると
 * この4つの口に収束する）が塞がる退行だった（fs は issue #1975 の時点から、
 * pg は issue #2011 のこの PR 自身の直しの時点から）。
 *
 * ここでは fs / pg の両方で、`kind` が空文字列（`workKindSchema.min(1)`
 * 違反）の壊れた行を直接書き（版ずれ・手編集を模す）、次を確かめる:
 *
 * - `PUT`/`DELETE /practices/:slug`（HTTP。CLI と Web UI が実際に叩く口——
 *   `apps/cli/src/practice.ts` の `write`/`remove`、
 *   `packages/swr/src/hooks/mutations.ts` の `usePracticeWrite`/`usePracticeRemove`
 *   はどちらもこの2つの HTTP 経路に収束する）は、壊れた行に対しても
 *   例外を投げずに書き直し・削除まで進む。
 * - `practice_write`/`practice_remove`（MCP。クローンの道具）も同様。
 * - 本当に無い slug は、これまでどおり 404 /「無かった」のままである。
 */

function stubCloneHost(): CloneHost {
  return {
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

/**
 * `kind` を空文字列にした壊れた行を fs の practices.json へ直接書く。
 *
 * **`kind = 'bogus'` ではなく空文字列にする理由**は `practiceKindSchema`
 * （`workKindSchema` = `z.string().min(1).max(128)`）が意図して enum に
 * していない自由文字列だから——「決められた一覧に無い値」はそもそも検査を
 * 通る。空文字列は `min(1)` に違反する、実際に検査へ落ちる形
 * （`packages/storage-pg/src/practices-malformed-row-repro.test.ts` と
 * 同じ判断）。
 */
async function fsStoresWithBadRow(): Promise<Stores> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.practices.write({
    slug: 'good-practice',
    kind: '実装',
    title: '正常なやり方',
    content: '正常な本文',
  });
  // `FsPracticeStore` は `paths.jobs` に practices.json を置く
  // （`packages/storage-fs/src/index.ts` の `createFsStores`）。
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

/** `kind` を空文字列にした壊れた行を pg の `practices` 表へ直接 insert する。 */
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

/** `createCloneTools` から `practice_write` / `practice_remove` を直接呼ぶ最小の器。 */
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
      // 壊れていた行の本文・題は日誌に出ない。
      const joined = entries.map((entry) => JSON.stringify(entry)).join('');
      expect(joined).not.toContain(BAD_TITLE);
      expect(joined).not.toContain(BAD_CONTENT);
    });

    it('DELETE /practices/:slug は壊れた行があっても消せる（直す前は read() の throw で 500）', async () => {
      const del = await app.request(`/practices/${BAD_SLUG}`, { method: 'DELETE' });
      const body = (await del.json().catch(() => undefined)) as unknown;
      expect(del.status, `本文: ${JSON.stringify(body)}`).toBe(200);

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

    /**
     * マネージャー指摘（フォローアップの2回目）。`GET /practices/:slug` は
     * `PUT`/`DELETE` と違い読めない行で投げるままにしたが（`practice_read`
     * と同じ理由）、素の 500（`onError` 任せ）の代わりに 409 を返すように
     * 変えた——これは API の応答の形そのものを新しく変えた変更（`openapi.json`
     * にも載った）なので、専用の歯を持つ。
     */
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
