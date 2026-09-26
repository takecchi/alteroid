import { PGlite } from '@electric-sql/pglite';
import type { CloneHost } from '@alteroid/core';
import { createPgStoresFromDb, migrate, type Db, type PgStores } from '@alteroid/storage-pg';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * Issue #1670。
 *
 * `GET /practices/:slug/versions` と `GET /practices/:slug/versions/:version`
 * には、`GET`/`PUT`/`DELETE /practices/:slug`（#1647/#1634）と同じ
 * `practiceSlugSchema` の 400 の門が無かった。fs / in-memory 実装
 * （`apps/daemon/src/app.test.ts` の歯）では `PracticeStore` が不正な slug で
 * 例外を投げないので、直す前も 200（空配列）/ 404 に落ちるだけで再現しない。
 *
 * ここでは issue が「読みだけで実行していない」と申告していた主張——
 * **pg 実装（`PgPracticeStore#slug()`、`packages/storage-pg/src/practices.ts`）
 * では `this.#slug(slug)` が無条件に例外を投げ、`apps/daemon/src/app.ts` の
 * `onError` がそれを 500 にする**——を、PGlite（インプロセスの実 PostgreSQL）
 * を使って実際に HTTP 層まで通して確かめる。
 *
 * 直す前: 500（`Internal Server Error`）。
 * 直した後: 400（`{ error: 'やり方のスラッグが不正' }`）。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;
let app: ReturnType<typeof createApp>;

/**
 * `CloneHost` の最小スタブ。このテストが叩くのは読み取り専用の
 * `/practices/:slug/versions*` だけで、クローンへは一度も到達しないので、
 * 型を満たすためだけの空実装で足りる。
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

const badSlug = 'Not_Valid_SLUG!';

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
  app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
});

describe('GET /practices/:slug/versions* は不正なスラッグを 400 で断る（pg 実装。issue #1670）', () => {
  it('GET /practices/:slug/versions — 直す前は pg で 500 だった', async () => {
    const res = await app.request(`/practices/${badSlug}/versions`);
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    expect(res.status, `本文: ${JSON.stringify(body)}`).toBe(400);
    expect(body).toEqual({ error: 'やり方のスラッグが不正' });
  });

  it('GET /practices/:slug/versions/:version — 直す前は pg で 500 だった', async () => {
    const res = await app.request(`/practices/${badSlug}/versions/1`);
    const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    expect(res.status, `本文: ${JSON.stringify(body)}`).toBe(400);
    expect(body).toEqual({ error: 'やり方のスラッグが不正' });
  });

  it('比較対象: 形式が正しい slug は今までどおり通る（pg 実装）', async () => {
    await stores.practices.write({
      slug: 'investigate-1670',
      kind: '調査',
      title: '題',
      content: '本文',
    });

    const list = await app.request('/practices/investigate-1670/versions');
    expect(list.status).toBe(200);

    const read = await app.request('/practices/investigate-1670/versions/1');
    expect(read.status).toBe(200);
  });
});
