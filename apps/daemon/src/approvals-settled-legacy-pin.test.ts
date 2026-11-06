import { createManagerPool, createRunnerRegistry, fakeCloneHost } from '@alteroid/core';
import type { CloneHost, PendingApproval, Stores } from '@alteroid/core';
import { createPgStoresFromDb, migrate } from '@alteroid/storage-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// 決着の時刻の列が空で、本体にだけ時刻がある「古い行」を、ルートを通して固定する。本体の時刻が `toISOString()` の形でない行
// （ミリ秒無し・オフセット付き）でも、日と件数・日で絞った承認が、「本体から補う」実装でも「`migrate` が列を埋め戻す」実装でも変わらない。
// 古い行は、ふつうに書いたあと生 SQL で列を null に戻して作り、`migrate` をもう一度回してから読む。
// 縛らないこと: `pending=true` の一覧に古い取り下げ済みの行が出るか（埋め戻しで出なくなる）。

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
  return fakeCloneHost({
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
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

// 日は Asia/Tokyo（`localDate()`）で決まる。
const ROWS: { row: PendingApproval; legacy: boolean }[] = [
  // JST 2026-09-03
  {
    row: approval('ap-l1', {
      answeredAt: '2026-09-03T01:02:03Z',
      answer: '1',
      conversationId: 'conv-1',
    }),
    legacy: true,
  },
  {
    row: approval('ap-l2', { answeredAt: '2026-09-03T09:02:03+09:00', answer: '2' }),
    legacy: true,
  },
  {
    row: approval('ap-normal', { answeredAt: '2026-09-03T05:00:00.000Z', answer: 'n' }),
    legacy: false,
  },
  // 日の境目: UTC では 09-03 だが JST では 09-04
  {
    row: approval('ap-l3', {
      answeredAt: '2026-09-04T00:30:00+09:00',
      answer: '3',
      conversationId: 'conv-1',
    }),
    legacy: true,
  },
  { row: approval('ap-l4', { answeredAt: '2026-09-03T15:00:00Z', answer: '4' }), legacy: true },
  // JST 2026-09-04 の取り下げ（UTC では 09-04 の 00:00）
  {
    row: approval('ap-lw', { withdrawnAt: '2026-09-04T09:00:00+09:00', withdrawnReason: '古い' }),
    legacy: true,
  },
  // 別の日
  { row: approval('ap-far', { answeredAt: '2026-01-01T00:00:00Z', answer: '昔' }), legacy: true },
  { row: approval('ap-open'), legacy: false },
];

async function seededStores(): Promise<Stores> {
  const { client, db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  for (const { row } of ROWS) await stores.jobs.putApproval(row);
  for (const { row, legacy } of ROWS) {
    if (!legacy) continue;
    await client.exec(
      `update approvals set answered_at = null, withdrawn_at = null where id = '${row.id}'`,
    );
  }
  // 書き換え後は、ここで列が埋め戻される
  await migrate(db);
  return stores;
}

async function idsOn(stores: Stores, query: string): Promise<string[]> {
  const body = (await getJson(stores, `/approvals?${query}`)) as { approvals: { id: string }[] };
  return body.approvals.map((entry) => entry.id);
}

describe('古い行の決着の日（ルート経由。本体の時刻が toISOString の形でない行を含む）', () => {
  it('GET /approvals/answered-dates は、日と件数が変わらない', async () => {
    const stores = await seededStores();

    expect(await getJson(stores, '/approvals/answered-dates?limit=60')).toEqual({
      dates: [
        { date: '2026-09-04', count: 3 },
        { date: '2026-09-03', count: 3 },
        { date: '2026-01-01', count: 1 },
      ],
    });
    expect(await getJson(stores, '/approvals/answered-dates?limit=1')).toEqual({
      dates: [{ date: '2026-09-04', count: 3 }],
    });
    expect(
      await getJson(stores, '/approvals/answered-dates?limit=60&beforeDate=2026-09-04'),
    ).toEqual({
      dates: [
        { date: '2026-09-03', count: 3 },
        { date: '2026-01-01', count: 1 },
      ],
    });
  }, 30_000);

  it('GET /approvals?answeredOn= は、その日に決着した承認を新しい順に返す', async () => {
    const stores = await seededStores();

    expect(await idsOn(stores, 'answeredOn=2026-09-03')).toEqual(['ap-normal', 'ap-l1', 'ap-l2']);
    expect(await idsOn(stores, 'answeredOn=2026-09-04')).toEqual(['ap-lw', 'ap-l3', 'ap-l4']);
    expect(await idsOn(stores, 'answeredOn=2026-01-01')).toEqual(['ap-far']);
    expect(await idsOn(stores, 'answeredOn=2026-08-01')).toEqual([]);
  }, 30_000);

  it('会話の絞り付きでも、その会話の古い行だけが返る', async () => {
    const stores = await seededStores();

    expect(await idsOn(stores, 'answeredOn=2026-09-03&conversationId=conv-1')).toEqual(['ap-l1']);
    expect(await idsOn(stores, 'answeredOn=2026-09-04&conversationId=conv-1')).toEqual(['ap-l3']);
    expect(await idsOn(stores, 'answeredOn=2026-09-04&conversationId=conv-none')).toEqual([]);
  }, 30_000);

  it('返る承認の本体の時刻は書いたままの文字列', async () => {
    const stores = await seededStores();

    const body = (await getJson(stores, '/approvals?answeredOn=2026-09-03')) as {
      approvals: { id: string; answeredAt: string }[];
    };
    expect(body.approvals.map((entry) => [entry.id, entry.answeredAt])).toEqual([
      ['ap-normal', '2026-09-03T05:00:00.000Z'],
      ['ap-l1', '2026-09-03T01:02:03Z'],
      ['ap-l2', '2026-09-03T09:02:03+09:00'],
    ]);
  }, 30_000);
});
