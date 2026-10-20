import { createManagerPool, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, JobStore, PendingApproval, Stores } from '@alteroid/core';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// 承認の日付絞り（`GET /approvals?answeredOn=`・`GET /approvals/answered-dates`）を DB の側で絞る（#5089）。
// 器の口を使った応答が、口を隠して全件読みに倒した応答と一致することを測る

const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

function cloneOver(stores: Stores): CloneHost {
  return {
    postPersisted: async () => 'persisted',
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

function withoutSettledMethods(base: Stores): Stores {
  const jobs = new Proxy(base.jobs, {
    get(target, property, receiver) {
      if (property === 'listApprovalsSettledAround' || property === 'listApprovalSettledAts') {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as JobStore;
  return { ...base, jobs };
}

async function getJson(stores: Stores, path: string): Promise<unknown> {
  const app = createApp({
    clone: cloneOver(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
  });
  const response = await app.request(path, { headers: { authorization: 'Bearer test-token' } });
  expect(response.status).toBe(200);
  return response.json();
}

function approval(id: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return { id, createdAt: '2026-09-01T00:00:00.000Z', question: `質問 ${id}`, ...over };
}

describe('承認の日付絞りを DB の側で絞る（pg。#5089）', () => {
  it('⭐ answeredOn・answered-dates の応答は、全件を読んで絞ったときと同じ（日の境目・取り下げ・会話の絞り・列の空いた古い行を含む）', async () => {
    const { db } = await createMigratedPglite();
    const stores = createPgStoresFromDb(db);
    const rows: PendingApproval[] = [
      approval('ap-a', { answeredAt: '2026-09-29T14:59:59.999Z', answer: 'a' }),
      approval('ap-b', {
        answeredAt: '2026-09-29T15:00:00.000Z',
        answer: 'b',
        conversationId: 'conv-1',
      }),
      approval('ap-c', {
        answeredAt: '2026-09-30T14:59:59.999Z',
        answer: 'c',
        conversationId: 'conv-1',
      }),
      approval('ap-d', { withdrawnAt: '2026-09-30T05:00:00.000Z', withdrawnReason: '要らない' }),
      approval('ap-e', { answeredAt: '2026-09-30T05:00:00+09:00', answer: 'e' }),
      approval('ap-f', { answeredAt: '2026-10-05T01:00:00.000Z', answer: 'f' }),
      approval('ap-g', {
        answeredAt: '2026-09-28T03:00:00.000Z',
        answer: 'g',
        withdrawnAt: '2026-09-30T03:00:00.000Z',
      }),
      approval('ap-open'),
    ];
    for (const row of rows) await stores.jobs.putApproval(row);
    // 決着の列（`withdrawn_at`）が無かった頃の行: 列は空で、本体にだけ取り下げの時刻がある
    await db.insert(tables.approvals).values({
      id: 'ap-legacy',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      answeredAt: null,
      withdrawnAt: null,
      approval: approval('ap-legacy', {
        withdrawnAt: '2026-09-30T06:00:00.000Z',
        withdrawnReason: '古い',
      }),
    });

    const plain = withoutSettledMethods(stores);
    for (const path of [
      '/approvals?answeredOn=2026-09-30',
      '/approvals?answeredOn=2026-09-29',
      '/approvals?answeredOn=2026-10-05',
      '/approvals?answeredOn=2026-08-01',
      '/approvals?answeredOn=2026-09-30&conversationId=conv-1',
      '/approvals/answered-dates?limit=60',
      '/approvals/answered-dates?limit=2',
      '/approvals/answered-dates?limit=60&beforeDate=2026-09-30',
    ]) {
      expect(await getJson(stores, path), path).toEqual(await getJson(plain, path));
    }
    // 中身の確かめ: 古い行も、その日に数えられる
    const onDay = (await getJson(stores, '/approvals?answeredOn=2026-09-30')) as {
      approvals: { id: string }[];
    };
    expect(onDay.approvals.map((entry) => entry.id)).toContain('ap-legacy');
  });

  it('answered-dates は承認の本文を読まない（選ぶのは決着の2つの欄だけ）', async () => {
    const { client, db } = await createMigratedPglite();
    void db;
    const queries: string[] = [];
    const { drizzle } = await import('drizzle-orm/pglite');
    const logged = createPgStoresFromDb(
      drizzle(client, {
        logger: {
          logQuery: (text) => {
            queries.push(text);
          },
        },
      }),
    );
    await logged.jobs.putApproval(
      approval('ap-x', { answeredAt: '2026-09-30T05:00:00.000Z', answer: 'x' }),
    );
    queries.length = 0;
    await getJson(logged, '/approvals/answered-dates');
    const selects = queries.filter(
      (text) => text.startsWith('select') && text.includes('"approvals"'),
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]).not.toMatch(/select "id", "approval"/);
  });
});
