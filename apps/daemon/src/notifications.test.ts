import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, PendingApproval, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * `GET /notifications` / `POST /notifications/read`（issue #2515）。
 *
 * 元は承認待ちキュー、新しく持つのは既読の位置（全員で1組）だけ。同じ筋書きを
 * インメモリ・fs・pg の3つの器で通す（器が違って未読数が変わる、を作らない）。
 *
 * 陰性対照の本物の経路（マネージャー→クローンの確認）は `packages/core` の
 * `manager.test.ts`「通知一覧（issue #2515）の陰性対照」にある。ここでは HTTP の口が
 * 日誌の `escalation` を拾わないことを、マネージャーが書くのと同じ形の行で測る。
 */

const NOW = new Date('2026-10-01T01:00:00.000Z');

function fakeCloneHost(stores: Stores): CloneHost {
  return {
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

function appOver(stores: Stores) {
  return createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
    now: () => NOW,
  });
}

interface FeedBody {
  notifications: { approvalId: string; read: boolean; kind: string; question: string }[];
  unreadCount: number;
  readThrough: string | null;
  latestAt?: string;
  cursorUnreadable?: string;
}

async function getFeed(stores: Stores): Promise<FeedBody> {
  const response = await appOver(stores).request('/notifications', {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as FeedBody;
}

async function markRead(stores: Stores, body: unknown): Promise<Response> {
  return appOver(stores).request('/notifications/read', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function approval(id: string, createdAt: string): PendingApproval {
  return { id, createdAt, question: `確認 ${id}` };
}

/** 3つの器で同じことを測る筋書き。 */
async function scenario(stores: Stores): Promise<void> {
  // 前提: 空
  const empty = await getFeed(stores);
  expect(empty).toMatchObject({ notifications: [], unreadCount: 0, readThrough: null });
  expect('latestAt' in empty).toBe(false);

  // 陽性対照: 1件積むと一覧に出て未読が増える
  await stores.jobs.putApproval(approval('ap-1', '2026-10-01T00:00:01.000Z'));
  const one = await getFeed(stores);
  expect(one.unreadCount).toBe(1);
  expect(one.notifications).toEqual([
    expect.objectContaining({ kind: 'approval_pending', approvalId: 'ap-1', read: false }),
  ]);
  expect(one.latestAt).toBe('2026-10-01T00:00:01.000Z');

  // 陰性対照: マネージャー→クローンの確認と同じ形の日誌の行は拾わない
  await stores.journal.append({
    type: 'escalation',
    question: 'Bash の実行許可: ls',
    approvalId: 'req-from-manager',
    managerId: 'mgr-1',
  });
  const afterEscalation = await getFeed(stores);
  expect(afterEscalation.notifications.map((n) => n.approvalId)).toEqual(['ap-1']);
  expect(afterEscalation.unreadCount).toBe(1);

  // 既読にすると減る
  const readResponse = await markRead(stores, { through: one.latestAt });
  expect(readResponse.status).toBe(200);
  const read = (await readResponse.json()) as FeedBody;
  expect(read.unreadCount).toBe(0);
  expect(read.readThrough).toBe('2026-10-01T00:00:01.000Z');
  expect((await getFeed(stores)).unreadCount).toBe(0);

  // 既読の後に積まれたものは未読
  await stores.jobs.putApproval(approval('ap-2', '2026-10-01T00:00:02.000Z'));
  const two = await getFeed(stores);
  expect(two.unreadCount).toBe(1);
  expect(two.notifications.map((n) => [n.approvalId, n.read])).toEqual([
    ['ap-2', false],
    ['ap-1', true],
  ]);

  // 古い位置を渡しても戻らない
  const stale = await markRead(stores, { through: '2026-10-01T00:00:00.000Z' });
  expect(stale.status).toBe(200);
  expect(((await stale.json()) as FeedBody).readThrough).toBe('2026-10-01T00:00:01.000Z');

  // 答えると、既読にしなくても一覧から消える
  await stores.jobs.updateApproval('ap-2', (current) => ({
    ...current,
    answeredAt: '2026-10-01T00:30:00.000Z',
    answer: 'はい',
  }));
  const answered = await getFeed(stores);
  expect(answered.notifications.map((n) => n.approvalId)).toEqual(['ap-1']);
  expect(answered.unreadCount).toBe(0);
}

beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe('GET /notifications ・ POST /notifications/read（issue #2515）', () => {
  it('インメモリの器', async () => {
    await scenario(createMemoryStores());
  });

  it('fs の器', async () => {
    await scenario(createFsStores(await makeTempDir('alteroid-test-')));
  });

  describe('pg の器', () => {
    let client: PGlite | undefined;
    afterEach(async () => {
      await client?.close();
      client = undefined;
    });

    it('同じ筋書きが通る', async () => {
      const migrated = await createMigratedPglite();
      client = migrated.client;
      await scenario(createPgStoresFromDb(migrated.db));
    });
  });

  it('既読の位置は器にだけ在り、app を作り直しても同じ位置を読む（入口ごとの状態を持たない）', async () => {
    // 器は1つ、デーモンの app は呼ぶたびに作り直す。⚠️ 2つのアカウントで入る形は
    // 測っていない——「全員で1組」は、口が誰の資格かを1つも受け取らない形で保っている。
    const stores = createMemoryStores();
    await stores.jobs.putApproval(approval('ap-1', '2026-10-01T00:00:01.000Z'));
    await markRead(stores, { through: '2026-10-01T00:00:01.000Z' });
    expect((await getFeed(stores)).unreadCount).toBe(0);
  });

  it('through が無い本文は 400 で、位置は動かない', async () => {
    const stores = createMemoryStores();
    const response = await markRead(stores, {});
    expect(response.status).toBe(400);
    expect((await stores.notifications.readCursor()).state).toBe('none');
  });

  it('デーモンの時計より1分を超えて先の through は 400 で、位置は動かない', async () => {
    const stores = createMemoryStores();
    const response = await markRead(stores, { through: '2026-10-01T01:01:01.000Z' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('動かしていない');
    expect((await stores.notifications.readCursor()).state).toBe('none');

    // 対照: 1分以内のずれは通る
    const within = await markRead(stores, { through: '2026-10-01T01:00:30.000Z' });
    expect(within.status).toBe(200);
  });

  it('既読の位置が読めないときは 200 で、全件を未読として数え、理由を返す', async () => {
    const root = await makeTempDir('alteroid-test-');
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(join(root, 'jobs', 'notifications.json'), '{ broken', 'utf8');
    const stores = createFsStores(root);
    await stores.jobs.putApproval(approval('ap-1', '2026-10-01T00:00:01.000Z'));

    const feed = await getFeed(stores);
    expect(feed.unreadCount).toBe(1);
    expect(feed.readThrough).toBeNull();
    expect(feed.cursorUnreadable).toContain('JSON');
  });
});
