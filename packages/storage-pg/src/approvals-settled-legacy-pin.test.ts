import type { PendingApproval } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { migrate } from './migrate.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 決着の時刻の列（`answered_at`・`withdrawn_at`）が空で、本体（jsonb）にだけ `answeredAt`・`withdrawnAt` がある「古い行」の読みを、
// 「本体から補う」実装でも「`migrate` が本体の時刻で列を埋め戻す」実装でも変わらない範囲で固定する。
// 古い行は、ふつうに書いたあと生 SQL で2つの列を null に戻して作り、`migrate(db)` をもう一度回してから読む（埋め戻す実装なら、ここで埋まる）。
//
// 縛らないこと:
// - `listApprovals({ pendingOnly: true })` に古い取り下げ済みの行が出るか。今は列が空なので「未決着」に見えて出るが、
//   埋め戻すと出なくなる（正しい向きの変化）。どちらも縛らない。
// - `listApprovalsSettledAround` が、範囲の外にある古い行を返すか。今は列が空の古い行を範囲に関係なく混ぜるが、
//   埋め戻すと範囲で絞られる。範囲の外の古い行は、返ってもよいし返らなくてもよい（返す集合の包含だけを見る）。
// - 本体の時刻が `toISOString()` の形でない古い行の `listApprovalSettledAts` の文字列（今は本体の文字列のまま、埋め戻すと `toISOString()` の形）。
//   その形の行は apps/daemon 側の `approvals-settled-legacy-pin.test.ts` が、日と件数で固定する。

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

function approval(id: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return { id, createdAt: '2026-09-01T00:00:00.000Z', question: `質問 ${id}`, ...over };
}

// 範囲は 2026-09-02 〜 2026-09-12。`listApprovalsSettledAround` は前後に1日ずつ広げる（2026-09-01 〜 2026-09-13）。
const RANGE = { since: '2026-09-02T00:00:00.000Z', until: '2026-09-12T00:00:00.000Z' };

const legacyAnswered = approval('ap-legacy-answered', {
  answeredAt: '2026-09-03T01:02:03.456Z',
  answer: '回答',
  conversationId: 'conv-1',
});
const legacyWithdrawn = approval('ap-legacy-withdrawn', {
  withdrawnAt: '2026-09-10T04:05:06.789Z',
  withdrawnReason: '要らない',
  conversationId: 'conv-2',
});
// 両方在る古い行: `answeredAt` を優先する
const legacyBoth = approval('ap-legacy-both', {
  answeredAt: '2026-09-06T07:08:09.012Z',
  answer: '両方',
  withdrawnAt: '2026-09-07T07:08:09.012Z',
  conversationId: 'conv-1',
});
// 範囲の外の古い行
const legacyFar = approval('ap-legacy-far', {
  answeredAt: '2026-12-25T00:00:00.123Z',
  answer: '遠い',
  conversationId: 'conv-1',
});
const open = approval('ap-open', { conversationId: 'conv-1' });
const normalAnswered = approval('ap-normal-answered', {
  answeredAt: '2026-09-04T11:12:13.014Z',
  answer: 'ふつう',
  conversationId: 'conv-1',
});
const normalWithdrawn = approval('ap-normal-withdrawn', {
  withdrawnAt: '2026-09-05T21:22:23.024Z',
  withdrawnReason: 'ふつうに取り下げ',
  conversationId: 'conv-2',
});
// 範囲（前後1日を足しても）の外のふつうの行
const normalFarAnswered = approval('ap-normal-far-answered', {
  answeredAt: '2026-01-01T00:00:00.000Z',
  answer: '昔',
  conversationId: 'conv-1',
});
const normalFarWithdrawn = approval('ap-normal-far-withdrawn', {
  withdrawnAt: '2026-12-31T23:59:59.999Z',
  withdrawnReason: '先',
  conversationId: 'conv-2',
});

const LEGACY = [legacyAnswered, legacyWithdrawn, legacyBoth, legacyFar];
const ALL = [
  ...LEGACY,
  open,
  normalAnswered,
  normalWithdrawn,
  normalFarAnswered,
  normalFarWithdrawn,
];

async function seed(): Promise<void> {
  for (const row of ALL) await stores.jobs.putApproval(row);
  for (const row of LEGACY) {
    await client.exec(
      `update approvals set answered_at = null, withdrawn_at = null where id = '${row.id}'`,
    );
  }
  // 書き換え後は、ここで列が埋め戻される
  await migrate(db);
}

async function settledAtsOf(): Promise<string[]> {
  const settledAts = stores.jobs.listApprovalSettledAts;
  if (settledAts === undefined) throw new Error('listApprovalSettledAts が無い');
  return settledAts.call(stores.jobs);
}

async function aroundIds(conversationId?: string): Promise<{
  ids: string[];
  entries: PendingApproval[];
}> {
  const around = stores.jobs.listApprovalsSettledAround;
  if (around === undefined) throw new Error('listApprovalsSettledAround が無い');
  const list = await around.call(
    stores.jobs,
    RANGE,
    conversationId === undefined ? {} : { conversationId },
  );
  expect(list.unreadable).toEqual([]);
  return { ids: list.entries.map((entry) => entry.id).sort(), entries: list.entries };
}

describe('listApprovalSettledAts（古い行を含む）', () => {
  it('決着した行の時刻だけを返す（列があれば列、古い行は本体。answeredAt が先、決着していない行は無い）', async () => {
    await seed();

    const settledAts = await settledAtsOf();

    expect([...settledAts].sort()).toEqual(
      [
        '2026-09-03T01:02:03.456Z',
        '2026-09-10T04:05:06.789Z',
        '2026-09-06T07:08:09.012Z',
        '2026-12-25T00:00:00.123Z',
        '2026-09-04T11:12:13.014Z',
        '2026-09-05T21:22:23.024Z',
        '2026-01-01T00:00:00.000Z',
        '2026-12-31T23:59:59.999Z',
      ].sort(),
    );
  });

  it('古い行が無いときは、ふつうの行の時刻だけを返す', async () => {
    for (const row of [open, normalAnswered, normalWithdrawn]) await stores.jobs.putApproval(row);
    await migrate(db);

    expect([...(await settledAtsOf())].sort()).toEqual([
      '2026-09-04T11:12:13.014Z',
      '2026-09-05T21:22:23.024Z',
    ]);
  });
});

describe('listApprovalsSettledAround（古い行を含む）', () => {
  // 範囲の内の行はすべて返る。ふつうの行は、範囲（前後1日を足す）の外なら返らない。決着していない行は返らない。
  // 範囲の外の古い行（`ap-legacy-far`）は縛らない（冒頭の注記）。
  const MUST = [
    'ap-legacy-answered',
    'ap-legacy-both',
    'ap-legacy-withdrawn',
    'ap-normal-answered',
    'ap-normal-withdrawn',
  ];
  const MUST_NOT = ['ap-normal-far-answered', 'ap-normal-far-withdrawn', 'ap-open'];

  it('範囲の内の古い行・ふつうの行が返り、範囲の外のふつうの行と決着していない行は返らない', async () => {
    await seed();

    const { ids } = await aroundIds();

    for (const id of MUST) expect(ids, id).toContain(id);
    for (const id of MUST_NOT) expect(ids, id).not.toContain(id);
    // 余計な行は、範囲の外の古い行だけ
    expect(ids.filter((id) => !MUST.includes(id))).toSatisfy((rest: string[]) =>
      rest.every((id) => id === 'ap-legacy-far'),
    );
  });

  it('返る entries の本体は書いたままの中身（古い行も）', async () => {
    await seed();

    const { entries } = await aroundIds();

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const row of [
      legacyAnswered,
      legacyWithdrawn,
      legacyBoth,
      normalAnswered,
      normalWithdrawn,
    ]) {
      expect(byId.get(row.id), row.id).toEqual(row);
    }
  });

  it('会話の絞り付きでも、その会話の古い行・ふつうの行だけが返る', async () => {
    await seed();

    const conv1 = await aroundIds('conv-1');
    expect(conv1.ids).toEqual(
      expect.arrayContaining(['ap-legacy-answered', 'ap-legacy-both', 'ap-normal-answered']),
    );
    for (const id of ['ap-legacy-withdrawn', 'ap-normal-withdrawn', ...MUST_NOT]) {
      expect(conv1.ids, id).not.toContain(id);
    }
    expect(conv1.entries.every((entry) => entry.conversationId === 'conv-1')).toBe(true);

    const conv2 = await aroundIds('conv-2');
    expect(conv2.ids).toEqual(['ap-legacy-withdrawn', 'ap-normal-withdrawn']);
    expect(conv2.entries.find((entry) => entry.id === 'ap-legacy-withdrawn')).toEqual(
      legacyWithdrawn,
    );

    expect((await aroundIds('conv-none')).ids).toEqual([]);
  });
});
