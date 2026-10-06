import { createManagerPool, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, PendingApproval, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * `GET /approvals?answeredOn=` と `GET /approvals/answered-dates`（回答済みの画面の口）。
 *
 * - 日は日報と同じ `localDate()`（デーモンの TZ）で決まる。**TZ の境界**は、東京の日の始まり・終わりの
 *   1ミリ秒前後に決着を置いて測る。TZ はこのファイルで固定する（`scripts/check-test-tz-fixed.test.ts`。
 *   書き方は `report-catchup.test.ts` と同じ: import より先に効かせるため `vi.hoisted`）
 * - 決着の日時は `answeredAt`、無ければ `withdrawnAt`（取り下げ済みも見える）
 * - 並びは決着の新しい順、同時刻は id の降順
 * - fs / pg の2実装で同じ結果になる（フィルタと並べ替えはメモリ上で、保存先の並びに乗らない）
 */
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

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

function requestOver(stores: Stores) {
  const app = createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
  });
  return async (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: 'Bearer test-token', ...(init.headers as object | undefined) },
    });
}

function approval(id: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return { id, createdAt: '2026-09-01T00:00:00.000Z', question: `質問 ${id}`, ...over };
}

// 東京（UTC+9）の日の区切りは、UTC の 15:00。
const SEED: PendingApproval[] = [
  // 9/29 の最後の 1ms
  approval('ap-a', { answeredAt: '2026-09-29T14:59:59.999Z', answer: 'a' }),
  // 9/30 の最初の 1ms（UTC ではまだ 9/29）
  approval('ap-b', { answeredAt: '2026-09-29T15:00:00.000Z', answer: 'b' }),
  // 9/30 の最後の 1ms（UTC では 9/30 の 14:59:59）
  approval('ap-c', { answeredAt: '2026-09-30T14:59:59.999Z', answer: 'c' }),
  // 取り下げ済み。決着の日時は withdrawnAt
  approval('ap-d', { withdrawnAt: '2026-09-30T05:00:00.000Z', withdrawnReason: '要らない' }),
  // d と同時刻（id で安定させる）
  approval('ap-e', { answeredAt: '2026-09-30T05:00:00.000Z', answer: 'e' }),
  // 10/1 の最初の 1ms
  approval('ap-f', { answeredAt: '2026-09-30T15:00:00.000Z', answer: 'f' }),
  // 両方在る行（正常な経路では無い）は回答の日に置く
  approval('ap-g', {
    answeredAt: '2026-09-28T03:00:00.000Z',
    answer: 'g',
    withdrawnAt: '2026-09-30T03:00:00.000Z',
  }),
  // 未回答。どの日にも載らない
  approval('ap-open'),
];

type Get = (path: string, init?: RequestInit) => Promise<Response>;

/** fs / pg 共通。 */
function suite(open: () => Promise<{ get: Get; stores: Stores }>) {
  async function seeded() {
    const { get, stores } = await open();
    for (const row of SEED) await stores.jobs.putApproval(row);
    return { get, stores };
  }

  async function ids(get: Get, query: string): Promise<string[]> {
    const response = await get(`/approvals${query}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { approvals: { id: string }[] };
    return body.approvals.map((entry) => entry.id);
  }

  it('answeredOn: その日（localDate）に決着した件だけを、決着の新しい順・同時刻は id の降順で返す', async () => {
    const { get } = await seeded();
    // 9/30: c(23:59:59.999) → e,d(14:00。id の降順) → b(00:00:00.000)
    expect(await ids(get, '?answeredOn=2026-09-30')).toEqual(['ap-c', 'ap-e', 'ap-d', 'ap-b']);
  });

  it('answeredOn: 日の境界は1ミリ秒前後で別の日に分かれる（UTC の日付ではなくデーモンの TZ）', async () => {
    const { get } = await seeded();
    expect(await ids(get, '?answeredOn=2026-09-29')).toEqual(['ap-a']);
    expect(await ids(get, '?answeredOn=2026-10-01')).toEqual(['ap-f']);
  });

  it('answeredOn: 取り下げ済み（withdrawnAt だけ）も、その日に決着した件として見える。理由も付く', async () => {
    const { get } = await seeded();
    const body = (await (await get('/approvals?answeredOn=2026-09-30')).json()) as {
      approvals: {
        id: string;
        withdrawnAt?: string;
        withdrawnReason?: string;
        updatedAt: string;
      }[];
    };
    const withdrawn = body.approvals.find((entry) => entry.id === 'ap-d');
    expect(withdrawn?.withdrawnReason).toBe('要らない');
    expect(withdrawn?.updatedAt).toBe('2026-09-30T05:00:00.000Z');
  });

  it('answeredOn: answeredAt が在れば withdrawnAt より優先する（両方在る行は回答の日に載り、取り下げの日には載らない）', async () => {
    const { get } = await seeded();
    expect(await ids(get, '?answeredOn=2026-09-28')).toEqual(['ap-g']);
    expect(await ids(get, '?answeredOn=2026-09-30')).not.toContain('ap-g');
  });

  it('answeredOn: 未回答はどの日にも載らず、決着の無い日は空（鍵は approvals のまま）', async () => {
    const { get } = await seeded();
    expect(await ids(get, '?answeredOn=2026-01-01')).toEqual([]);
    for (const date of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) {
      expect(await ids(get, `?answeredOn=${date}`)).not.toContain('ap-open');
    }
  });

  it('answeredOn: pending=false の明示は併用できる。conversationId で絞れる', async () => {
    const { get, stores } = await seeded();
    expect(await ids(get, '?answeredOn=2026-09-29&pending=false')).toEqual(['ap-a']);
    await stores.jobs.putApproval(
      approval('ap-conv', { answeredAt: '2026-09-29T01:00:00.000Z', conversationId: 'c-1' }),
    );
    expect(await ids(get, '?answeredOn=2026-09-29&conversationId=c-1')).toEqual(['ap-conv']);
  });

  it('answeredOn: 日付の形が不正（2月30日・形違い）は /reports/:date と同じ形の 400', async () => {
    const { get } = await seeded();
    for (const bad of ['2026-02-30', '2026-9-30', 'garbage', '']) {
      const response = await get(`/approvals?answeredOn=${bad}`);
      expect(response.status, bad).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining('YYYY-MM-DD') });
    }
    const reports = await get('/reports/2026-02-30');
    expect(reports.status).toBe(400);
    expect(Object.keys((await reports.json()) as object)).toEqual(['error']);
  });

  it('answeredOn: pending=true・order・limit・cursor との併用は 400（黙って片方を無視しない）', async () => {
    const { get } = await seeded();
    for (const extra of ['pending=true', 'order=asc', 'order=desc', 'limit=1', 'cursor=x']) {
      const response = await get(`/approvals?answeredOn=2026-09-30&${extra}`);
      expect(response.status, extra).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
  });

  it('answeredOn を渡さない既定の応答は変わらない（封筒も無く、未回答だけ）', async () => {
    const { get } = await seeded();
    const body = (await (await get('/approvals')).json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['approvals']);
    expect((body.approvals as { id: string }[]).map((entry) => entry.id)).toEqual(['ap-open']);
    const all = (await (await get('/approvals?pending=false')).json()) as {
      approvals: unknown[];
    };
    expect(all.approvals).toHaveLength(SEED.length);
  });

  it('answered-dates: 決着のあった日と件数を、新しい日が上の順に返す（未回答は数えない）', async () => {
    const { get } = await seeded();
    const response = await get('/approvals/answered-dates');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dates: [
        { date: '2026-10-01', count: 1 },
        { date: '2026-09-30', count: 4 },
        { date: '2026-09-29', count: 1 },
        { date: '2026-09-28', count: 1 },
      ],
    });
  });

  it('answered-dates: 件数は answeredOn の件数と一致する', async () => {
    const { get } = await seeded();
    const { dates } = (await (await get('/approvals/answered-dates')).json()) as {
      dates: { date: string; count: number }[];
    };
    for (const { date, count } of dates) {
      expect(await ids(get, `?answeredOn=${date}`), date).toHaveLength(count);
    }
  });

  it('answered-dates: limit で切り、beforeDate（それより古い日）で続きを取れる', async () => {
    const { get } = await seeded();
    const page = async (query: string) =>
      (
        (await (await get(`/approvals/answered-dates${query}`)).json()) as {
          dates: { date: string }[];
        }
      ).dates.map((entry) => entry.date);
    expect(await page('?limit=2')).toEqual(['2026-10-01', '2026-09-30']);
    expect(await page('?limit=2&beforeDate=2026-09-30')).toEqual(['2026-09-29', '2026-09-28']);
    expect(await page('?beforeDate=2026-09-28')).toEqual([]);
  });

  it('answered-dates: limit の既定は 7・上限は 365（/reports と同じ）。不正な値・日付は 400', async () => {
    const { get, stores } = await seeded();
    expect((await get('/approvals/answered-dates?limit=365')).status).toBe(200);
    expect((await get('/approvals/answered-dates?limit=366')).status).toBe(400);
    expect((await get('/approvals/answered-dates?limit=0')).status).toBe(400);
    const bad = await get('/approvals/answered-dates?beforeDate=2026-02-30');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: expect.stringContaining('YYYY-MM-DD') });
    // 既定 7: 9日ぶんを積むと7日で切れる
    for (let day = 1; day <= 9; day += 1) {
      await stores.jobs.putApproval(
        approval(`ap-old-${day}`, { answeredAt: `2026-08-0${day}T03:00:00.000Z` }),
      );
    }
    const defaulted = (await (await get('/approvals/answered-dates')).json()) as {
      dates: unknown[];
    };
    expect(defaulted.dates).toHaveLength(7);
  });

  it('answered-dates は /approvals/:id 系に食われない（id として読まれて 404 にならない）', async () => {
    const { get } = await seeded();
    const response = await get('/approvals/answered-dates');
    expect(response.status).toBe(200);
    expect(Object.keys((await response.json()) as object)).toEqual(['dates']);
    // 3区間の既存の口は今までどおり id として読まれる（無い id は 404）
    expect((await get('/approvals/answered-dates/trace')).status).toBe(404);
  });

  it('GET /approvals/:id: 承認1件と、決着した日（localDate）を返す。日の境界は answeredOn と同じ', async () => {
    const { get } = await seeded();
    const settledOn = async (id: string) => {
      const response = await get(`/approvals/${id}`);
      expect(response.status, id).toBe(200);
      return (await response.json()) as {
        approval: { id: string; question: string; updatedAt: string };
        settledOn: string | null;
      };
    };
    // 東京の日の最後の 1ms / 最初の 1ms（UTC の日付とは別）
    expect((await settledOn('ap-a')).settledOn).toBe('2026-09-29');
    expect((await settledOn('ap-b')).settledOn).toBe('2026-09-30');
    expect((await settledOn('ap-c')).settledOn).toBe('2026-09-30');
    expect((await settledOn('ap-f')).settledOn).toBe('2026-10-01');
    // 取り下げ済みは withdrawnAt の日
    expect((await settledOn('ap-d')).settledOn).toBe('2026-09-30');
    // 両方在る行は回答の日
    expect((await settledOn('ap-g')).settledOn).toBe('2026-09-28');
    // 中身は一覧の1行と同じ（updatedAt つき）
    const body = await settledOn('ap-d');
    expect(body.approval).toMatchObject({
      id: 'ap-d',
      question: '質問 ap-d',
      updatedAt: '2026-09-30T05:00:00.000Z',
    });
  });

  it('GET /approvals/:id: 未回答・未取り下げの settledOn は null（鍵は在る）', async () => {
    const { get } = await seeded();
    const response = await get('/approvals/ap-open');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { approval: { id: string }; settledOn: null };
    expect(Object.keys(body)).toEqual(['approval', 'settledOn']);
    expect(body.approval.id).toBe('ap-open');
    expect(body.settledOn).toBeNull();
  });

  it('GET /approvals/:id: settledOn の日は、その id を answeredOn が返す日と必ず一致する（二重の定義が無い）', async () => {
    const { get } = await seeded();
    for (const row of SEED) {
      const { settledOn } = (await (await get(`/approvals/${row.id}`)).json()) as {
        settledOn: string | null;
      };
      if (settledOn === null) {
        expect(row.id).toBe('ap-open');
        continue;
      }
      expect(await ids(get, `?answeredOn=${settledOn}`), row.id).toContain(row.id);
    }
  });

  it('GET /approvals/:id: 日の区切りはデーモンの TZ に従う', async () => {
    const { get } = await seeded();
    const before = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      // ap-e（UTC 9/30 05:00）は、ロサンゼルスでは 9/29 の 22:00
      const body = (await (await get('/approvals/ap-e')).json()) as { settledOn: string };
      expect(body.settledOn).toBe('2026-09-29');
    } finally {
      process.env.TZ = before ?? 'Asia/Tokyo';
    }
  });

  it('GET /approvals/:id: 無い id は /approvals/:id/trace と同じ形の 404', async () => {
    const { get } = await seeded();
    const byId = await get('/approvals/no-such');
    expect(byId.status).toBe(404);
    const trace = await get('/approvals/no-such/trace');
    expect(trace.status).toBe(404);
    const byIdBody = await byId.json();
    expect(byIdBody).toEqual(await trace.json());
    expect(byIdBody).toEqual({ error: 'not found' });
  });

  it('GET /approvals/:id は answered-dates / answer の経路を食わない', async () => {
    const { get } = await seeded();
    // answered-dates は目次のまま（id として読まれて 404 / approval 形にならない）
    const dates = await get('/approvals/answered-dates');
    expect(dates.status).toBe(200);
    expect(Object.keys((await dates.json()) as object)).toEqual(['dates']);
    // 同じ形の他の経路は今までどおり
    const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const bulk = await get('/approvals/answer', {
      ...post,
      body: JSON.stringify({ answers: [{ id: 'ap-open', answer: 'よい' }] }),
    });
    expect(bulk.status).toBe(200);
    expect(Object.keys((await bulk.json()) as object)).toEqual(['results']);
    const one = await get('/approvals/ap-open/answer', {
      ...post,
      body: JSON.stringify({ answer: 'よい' }),
    });
    expect(one.status).not.toBe(404);
    // 3区間の既存の口も今までどおり
    expect((await get('/approvals/ap-a/trace')).status).toBe(200);
  });

  it('日の区切りはデーモンの TZ に従う（同じ瞬間でも TZ が違えば日が違う）', async () => {
    const { get } = await seeded();
    const before = process.env.TZ;
    try {
      // ロサンゼルス（UTC-7、9月）では ap-a（UTC 14:59:59.999）は 9/29 の 07:59、
      // ap-e / ap-d（UTC 9/30 05:00）は 9/29 の 22:00（東京では 9/30）
      process.env.TZ = 'America/Los_Angeles';
      expect(await ids(get, '?answeredOn=2026-09-29')).toEqual(['ap-e', 'ap-d', 'ap-b', 'ap-a']);
      const { dates } = (await (await get('/approvals/answered-dates')).json()) as {
        dates: { date: string }[];
      };
      expect(dates.map((entry) => entry.date)).toEqual(['2026-09-30', '2026-09-29', '2026-09-27']);
    } finally {
      process.env.TZ = before ?? 'Asia/Tokyo';
    }
  });
}

beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe('回答済みの承認の口（fs）', () => {
  suite(async () => {
    const root = await makeTempDir('alteroid-test-');
    const stores = createFsStores(root);
    return { stores, get: requestOver(stores) };
  });
});

describe('回答済みの承認の口（pg）', () => {
  let client: PGlite | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });
  suite(async () => {
    const migrated = await createMigratedPglite();
    client = migrated.client;
    const stores = createPgStoresFromDb(migrated.db);
    return { stores, get: requestOver(stores) };
  });
});
