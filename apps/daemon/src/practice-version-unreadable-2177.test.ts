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

// 雛形の前払い（#3034）。最初の `beforeEach`（hookTimeout 10s）で WASM の起動 + migrate を
// 払わせない。
beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

/**
 * issue #2177。`PracticeStore.readVersion()`（fs / pg どちらも issue #2011 の
 * 時点から）は読めない版の行で `UnreadablePracticeError` を投げる契約だが、
 * それを消費する側の2口——`GET /practices/:slug/versions/:version`
 * （`apps/daemon/src/app.ts`）と道具 `practice_read`（`version` 指定。
 * `packages/core/src/tools.ts`）——は投げっぱなしにしていた。兄弟の口
 * `GET /practices/:slug` / `practice_read`（version 省略）は #2011 で
 * 直してあるのに、この2つだけ揃っていなかった（`practice-unreadable
 * -recovery-2011.test.ts` の対）。
 *
 * ここでは fs / pg の両方で、**版の履歴**（現在の本文ではない）に `kind` が
 * 空文字列（`practiceKindSchema.min(1)` 違反）の壊れた行を直接書き（版ずれ・
 * 手編集を模す）、次を確かめる:
 *
 * - `GET /practices/:slug/versions/:version` は 500（`onError` 任せ）ではなく
 *   409 を返し、本文（title/content）は応答に漏れない。
 * - `practice_read slug=<slug> version=<version>` は `isError` にならず、
 *   理由の分かる文を返す。
 * - 本当に無い版は、これまでどおり 404 /「無い」のままである（対照）。
 * - `UnreadablePracticeError` 以外の例外は、この2口とも投げ直す（範囲外の
 *   種類の例外を握り潰さないことの確認）。
 *
 * **マネージャー判断による追加分（issue #2177 の同じ症状の単位）。**
 * `practice_read`（`version` 省略。現在の本文を読む分岐）の
 * `stores.practices.read(slug)` 呼び出しも `UnreadablePracticeError` を
 * 捕まえていなかった——兄弟の `practice_write`/`practice_remove` は同じ
 * `read(slug)` を捕まえて「在ったが読めない」として進むのに、`practice_read`
 * の素の読み取りだけ未対応だった。下の2本目の `describe.each` は、**現在の
 * 本文**（`practices`。版の履歴ではない）に壊れた行を直接書き、同じ形
 * （`isError` にならない理由の分かる文・無い slug との対照・他の例外は
 * 投げ直す）を確かめる。
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

const BAD_SLUG = 'bad-practice-version';
const BAD_TITLE = '壊れた版の題（跡に出てはいけない）';
const BAD_CONTENT = '壊れた版の本文（跡に出てはいけない）';

/**
 * `slug` へ正常な版を1つ書いた後、**版の履歴**（`practiceVersions`）へ直接
 * `kind` が空文字列の壊れた版を追記する（fs）。現在の本文（`practices`）は
 * 正常なまま——読めないのはあくまで過去の版1件だけ、という状況を作る。
 */
async function fsStoresWithBadVersionRow(): Promise<Stores> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.practices.write({
    slug: BAD_SLUG,
    kind: '実装',
    title: '正常な版（version 1）',
    content: '正常な本文',
  });
  const practicesPath = join(root, 'jobs', 'practices.json');
  const raw = JSON.parse(await readFile(practicesPath, 'utf8')) as {
    practiceVersions: unknown[];
  };
  raw.practiceVersions.push({
    slug: BAD_SLUG,
    version: 2,
    kind: '',
    title: BAD_TITLE,
    content: BAD_CONTENT,
    at: '2026-09-02T00:00:00.000Z',
  });
  await writeFile(practicesPath, JSON.stringify(raw, null, 2), 'utf8');
  return stores;
}

/** 上と同じ状況を pg の `practice_versions` 表へ直接 insert して作る。 */
async function pgStoresWithBadVersionRow(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  await stores.practices.write({
    slug: BAD_SLUG,
    kind: '実装',
    title: '正常な版（version 1）',
    content: '正常な本文',
  });
  await db.insert(tables.practiceVersions).values({
    slug: BAD_SLUG,
    version: 2,
    kind: '',
    title: BAD_TITLE,
    content: BAD_CONTENT,
    at: new Date('2026-09-02T00:00:00.000Z'),
  });
  return stores;
}

/**
 * `practice_read` を直接呼び、`isError` まで見る。`createCloneTools` から
 * ツールの生のハンドラを呼ぶ——`h.call()` 相当のヘルパは他のテストファイルに
 * 何本もあるが `isError` を捨てる形なので、ここでは自前で持つ
 * （`tools.test.ts` の `describe('issue #2145…')` 内の `callExpectingError`
 * と同じ形）。
 */
function toolCaller(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { isError: result.isError === true, text };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { isError: true, text };
    }
  };
}

describe.each([
  ['fs', fsStoresWithBadVersionRow],
  ['pg', pgStoresWithBadVersionRow],
] as const)(
  '版の読めない行を HTTP / 道具の両方が名乗る（%s 実装。issue #2177）',
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

    it('GET /practices/:slug/versions/:version は壊れた版があると 409 を返し、本文は応答に載らない（直す前は 500）', async () => {
      const response = await app.request(`/practices/${BAD_SLUG}/versions/2`);
      const body = (await response.json().catch(() => undefined)) as unknown;
      expect(response.status, `本文: ${JSON.stringify(body)}`).toBe(409);
      const joined = JSON.stringify(body);
      expect(joined).toContain(BAD_SLUG);
      expect(joined).toContain('2');
      expect(joined).not.toContain(BAD_TITLE);
      expect(joined).not.toContain(BAD_CONTENT);
    });

    it('GET /practices/:slug/versions/:version は本当に無い版なら今までどおり 404（409 との対照）', async () => {
      const response = await app.request(`/practices/${BAD_SLUG}/versions/999`);
      expect(response.status).toBe(404);
    });

    it('GET /practices/:slug/versions/:version は UnreadablePracticeError 以外の例外を投げ直す', async () => {
      const originalReadVersion = stores.practices.readVersion.bind(stores.practices);
      stores.practices.readVersion = async (slug, version) => {
        if (slug === BAD_SLUG && version === 2) {
          throw new Error('実測用のダミー（器そのものの障害を模す）');
        }
        return originalReadVersion(slug, version);
      };
      app = createApp({
        clone: stubCloneHost(),
        stores,
        token: 'test-token',
        shutdown: () => undefined,
      });

      const response = await app.request(`/practices/${BAD_SLUG}/versions/2`);
      // **409 に丸め込まない。** `UnreadablePracticeError` 以外は `base.onError`
      // 任せの素の 500 になる（`app.ts` の `base.onError` の doc）。
      expect(response.status).toBe(500);
    });

    it('practice_read version=<n> は壊れた版があっても isError にならず、理由の分かる文を返す（直す前は isError と生の Zod issue）', async () => {
      const call = toolCaller(stores);
      const { isError, text } = await call('practice_read', { slug: BAD_SLUG, version: 2 });
      expect(isError, `本文: ${text}`).toBe(false);
      expect(text).toContain(BAD_SLUG);
      expect(text).toContain('2');
      expect(text).toContain('読めない形で入っている');
      expect(text).not.toContain(BAD_TITLE);
      expect(text).not.toContain(BAD_CONTENT);
    });

    it('practice_read version=<n> は本当に無い版なら今までどおり「無い」（409/isError との対照）', async () => {
      const call = toolCaller(stores);
      const { isError, text } = await call('practice_read', { slug: BAD_SLUG, version: 999 });
      expect(isError).toBe(false);
      expect(text).toContain('無い');
    });

    it('practice_read version=<n> は UnreadablePracticeError 以外の例外を投げ直す', async () => {
      const originalReadVersion = stores.practices.readVersion.bind(stores.practices);
      stores.practices.readVersion = async (slug, version) => {
        if (slug === BAD_SLUG && version === 2) {
          throw new Error('実測用のダミー（器そのものの障害を模す）');
        }
        return originalReadVersion(slug, version);
      };
      const call = toolCaller(stores);
      const { isError, text } = await call('practice_read', { slug: BAD_SLUG, version: 2 });
      expect(isError).toBe(true);
      expect(text).toContain('実測用のダミー');
    });

    it('practice_read（version 省略）はこの版の壊れ方の影響を受けない（現在の本文は正常なまま）', async () => {
      const call = toolCaller(stores);
      const { isError, text } = await call('practice_read', { slug: BAD_SLUG });
      expect(isError).toBe(false);
      expect(text).toContain('正常な版（version 1）');
    });
  },
);

const BAD_CURRENT_SLUG = 'bad-practice-current';
const BAD_CURRENT_TITLE = '壊れた現在の本文の題（跡に出てはいけない）';
const BAD_CURRENT_CONTENT = '壊れた現在の本文（跡に出てはいけない）';

/**
 * `kind` を空文字列にした壊れた**現在の**行を fs の practices.json へ直接書く
 * （`practice-unreadable-recovery-2011.test.ts` の `fsStoresWithBadRow` と
 * 同じ手口。版の履歴ではなく `practices` 配列そのものを壊す）。
 */
async function fsStoresWithBadCurrentRow(): Promise<Stores> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.practices.write({
    slug: 'good-practice-current',
    kind: '実装',
    title: '正常なやり方',
    content: '正常な本文',
  });
  const practicesPath = join(root, 'jobs', 'practices.json');
  const raw = JSON.parse(await readFile(practicesPath, 'utf8')) as { practices: unknown[] };
  raw.practices.push({
    slug: BAD_CURRENT_SLUG,
    kind: '',
    title: BAD_CURRENT_TITLE,
    content: BAD_CURRENT_CONTENT,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  });
  await writeFile(practicesPath, JSON.stringify(raw, null, 2), 'utf8');
  return stores;
}

/** 上と同じ状況を pg の `practices` 表へ直接 insert して作る。 */
async function pgStoresWithBadCurrentRow(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  await stores.practices.write({
    slug: 'good-practice-current',
    kind: '実装',
    title: '正常なやり方',
    content: '正常な本文',
  });
  await db.insert(tables.practices).values({
    slug: BAD_CURRENT_SLUG,
    kind: '',
    title: BAD_CURRENT_TITLE,
    content: BAD_CURRENT_CONTENT,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  });
  return stores;
}

describe.each([
  ['fs', fsStoresWithBadCurrentRow],
  ['pg', pgStoresWithBadCurrentRow],
] as const)(
  '現在の本文が読めない行を practice_read（version 省略）が名乗る（%s 実装。issue #2177）',
  (_label, makeStores) => {
    let stores: Stores;

    beforeEach(async () => {
      stores = await makeStores();
    });

    it('practice_read（version 省略）は現在の本文が壊れていても isError にならず、理由の分かる文を返す（直す前は isError と生の Zod issue）', async () => {
      const call = toolCaller(stores);
      const { isError, text } = await call('practice_read', { slug: BAD_CURRENT_SLUG });
      expect(isError, `本文: ${text}`).toBe(false);
      expect(text).toContain(BAD_CURRENT_SLUG);
      expect(text).toContain('読めない形で入っている');
      expect(text).toContain('practice_write');
      expect(text).toContain('practice_remove');
      expect(text).not.toContain(BAD_CURRENT_TITLE);
      expect(text).not.toContain(BAD_CURRENT_CONTENT);
    });

    it('practice_read（version 省略）は本当に無い slug なら今までどおり「無い」（isError との対照）', async () => {
      const call = toolCaller(stores);
      const { isError, text } = await call('practice_read', { slug: 'never-existed-current' });
      expect(isError).toBe(false);
      expect(text).toContain('無い');
    });

    it('practice_read（version 省略）は UnreadablePracticeError 以外の例外を投げ直す', async () => {
      const originalRead = stores.practices.read.bind(stores.practices);
      stores.practices.read = async (slug) => {
        if (slug === BAD_CURRENT_SLUG) {
          throw new Error('実測用のダミー（器そのものの障害を模す）');
        }
        return originalRead(slug);
      };
      const call = toolCaller(stores);
      const { isError, text } = await call('practice_read', { slug: BAD_CURRENT_SLUG });
      expect(isError).toBe(true);
      expect(text).toContain('実測用のダミー');
    });
  },
);
