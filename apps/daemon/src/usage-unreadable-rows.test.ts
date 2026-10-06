import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, createCloneTools, sumUsageRows } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * issue #2427。使用量の集計は、読めない行（`layer` / `site` が enum に無い等）を stderr に
 * 1行書いて外していたので、集計の出力のどこにも「外した」が出なかった。CLI・Web・クローンの
 * 道具は、100万トークン少ない値を断りなしの集計として出せた。今は集計の出力に
 * `unreadableRows`（表・日・読めなかった欄の名前。値は載せない）を運び、上の層が
 * 「読めない使用量の行が N 行あり、合計に入っていない」と言う。
 *
 * fs / pg の2実装を並べ、**実物のストアに読めない行を置いた状態から**、次の層を通す。
 *
 * - `aggregate()` — `unreadableRows` を運ぶ。`rows` にも合計にも、外した行の値は入らない
 * - 道具 `usage_read` — 合計の隣で「合計に入っていない」と言う
 * - `GET /usage` — `unreadableRows` を載せる
 * - 照会の範囲の外にある読めない行は、言わない
 *
 * 対照: 読めない行が無いとき、鍵も文も出ない。
 *
 * CLI と Web は HTTP の応答を描くだけなので、それぞれ `usage.test.ts` / `usage.test.tsx` /
 * `dashboard.test.tsx` が応答の形を差して測る。
 */

const SECRET_MODEL = 'unreadable-row-model-must-not-appear';
const BAD_DATE = '2026-09-27';
const GOOD_DATE = '2026-09-28';

async function recordFor(
  stores: Stores,
  managerId: string,
  date: string,
  inputTokens: number,
  model = 'opus',
): Promise<void> {
  await stores.usage.record({
    layer: 'manager',
    site: 'session',
    managerId,
    date,
    at: `${date}T00:00:00.000Z`,
    snapshot: {
      models: {
        [model]: {
          inputTokens,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 1,
        },
      },
    },
    accumulation: 'cumulative',
  });
}

interface Seeded {
  stores: Stores;
  /** managerId の行（消費量と回数の両方）を、未来の版が書いたような layer にする。 */
  breakLayerOf(managerId: string): Promise<void>;
}

async function seedFs(): Promise<Seeded> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  return {
    stores,
    async breakLayerOf(managerId) {
      let path = '';
      for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name === 'usage.json') {
          path = join(entry.parentPath, entry.name);
        }
      }
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        Record<string, { managerId: string; layer: string }>
      >;
      for (const table of ['rows', 'turns'] as const) {
        for (const row of Object.values(raw[table] ?? {})) {
          if (row.managerId === managerId) row.layer = 'not-a-real-layer-from-a-newer-deploy';
        }
      }
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    },
  };
}

async function seedPg(): Promise<Seeded> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  return {
    stores,
    async breakLayerOf(managerId) {
      const layer = 'not-a-real-layer-from-a-newer-deploy';
      await db
        .update(tables.usageDaily)
        .set({ layer })
        .where(eq(tables.usageDaily.managerId, managerId));
      await db
        .update(tables.usageTurns)
        .set({ layer })
        .where(eq(tables.usageTurns.managerId, managerId));
    },
  };
}

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: { list: async () => [] } as unknown as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

async function getUsage(stores: Stores, query = ''): Promise<Record<string, unknown>> {
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request(`/usage${query}`, {
    headers: { authorization: 'Bearer test-token' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function usageReadTool(stores: Stores): (args: Record<string, unknown>) => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  const tool = tools.find((entry) => entry.name === 'usage_read');
  if (!tool) throw new Error('usage_read が無い');
  return async (args) => {
    const result = await tool.handler(args as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

const EXPECTED_UNREADABLE = [
  { table: 'usage_daily', date: BAD_DATE, fields: ['layer'] },
  { table: 'usage_turns', date: BAD_DATE, fields: ['layer'] },
];

// PGlite の雛形（WASM の起動＋migrate）は、ワーカーで最初に呼んだ歯が払う。
// 歯の本体（既定 5000ms）でなく hook（明示 30_000ms）で払わせる（issue #2360、#2337 と同じ形）。
beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('使用量の集計が、読めずに外した行を出力へ運ぶ（%s 実装。#2427）', (_label, seed) => {
  async function seedWithBadRow(): Promise<Stores> {
    const { stores, breakLayerOf } = await seed();
    await recordFor(stores, 'mgr-good', GOOD_DATE, 10);
    await recordFor(stores, 'mgr-bad', BAD_DATE, 1_000_000, SECRET_MODEL);
    await breakLayerOf('mgr-bad');
    return stores;
  }

  it('aggregate(): unreadableRows に表・日・欄の名前だけを運び、外した行の値は rows にも合計にも入らない', async () => {
    const stores = await seedWithBadRow();

    let aggregate: Awaited<ReturnType<Stores['usage']['aggregate']>> | undefined;
    await captureStderr(async () => {
      aggregate = await stores.usage.aggregate({});
    });

    expect(aggregate?.unreadableRows).toEqual(EXPECTED_UNREADABLE);
    expect(aggregate?.rows.map((row) => row.managerId)).toEqual(['mgr-good']);
    expect(sumUsageRows(aggregate?.rows ?? []).inputTokens).toBe(10);
    expect(JSON.stringify(aggregate?.unreadableRows)).not.toContain(SECRET_MODEL);
    expect(JSON.stringify(aggregate?.unreadableRows)).not.toContain('mgr-bad');
  });

  it('usage_read: 合計の隣で「読めない使用量の行が 2 行あり、合計に入っていない」と言う', async () => {
    const stores = await seedWithBadRow();

    let reply = '';
    await captureStderr(async () => {
      reply = await usageReadTool(stores)({});
    });

    expect(reply).toContain(
      '⚠ 読めない使用量の行が 2 行あり、合計に入っていない' +
        `（読めない行の値は足していない。合計はその分少ない。内訳: 消費量の行 1 行 / 回数の行 1 行。日付: ${BAD_DATE}）。`,
    );
    expect(reply).toContain('入力 10 /');
    expect(reply).not.toContain('1,000,000');
    expect(reply).not.toContain(SECRET_MODEL);
  });

  it('GET /usage: unreadableRows を載せる。読めた行は今までどおり出る', async () => {
    const stores = await seedWithBadRow();

    let body: Record<string, unknown> = {};
    await captureStderr(async () => {
      body = await getUsage(stores);
    });

    expect(body.unreadableRows).toEqual(EXPECTED_UNREADABLE);
    expect((body.rows as { managerId: string }[]).map((row) => row.managerId)).toEqual([
      'mgr-good',
    ]);
    expect(JSON.stringify(body.unreadableRows)).not.toContain(SECRET_MODEL);
  });

  it('照会の範囲の外にある読めない行は、言わない（鍵も出ない）', async () => {
    const stores = await seedWithBadRow();

    let body: Record<string, unknown> = {};
    let reply = '';
    await captureStderr(async () => {
      body = await getUsage(stores, `?from=${GOOD_DATE}`);
      reply = await usageReadTool(stores)({ from: GOOD_DATE });
    });

    expect('unreadableRows' in body).toBe(false);
    expect(reply).not.toContain('読めない使用量の行');
  });

  it('読めた行が0件で、読めない行だけが在るとき、「記録が無い」だけで終わらない', async () => {
    const { stores, breakLayerOf } = await seed();
    await recordFor(stores, 'mgr-bad', BAD_DATE, 1_000_000, SECRET_MODEL);
    await breakLayerOf('mgr-bad');

    let reply = '';
    await captureStderr(async () => {
      reply = await usageReadTool(stores)({});
    });

    expect(reply).toContain('読めない使用量の行が 2 行あり、合計に入っていない');
  });

  it('対照: 読めない行が無ければ、鍵も文も出ない', async () => {
    const { stores } = await seed();
    await recordFor(stores, 'mgr-good', GOOD_DATE, 10);

    const aggregate = await stores.usage.aggregate({});
    expect('unreadableRows' in aggregate).toBe(false);
    const body = await getUsage(stores);
    expect('unreadableRows' in body).toBe(false);
    const reply = await usageReadTool(stores)({});
    expect(reply).not.toContain('読めない使用量の行');
    expect(reply).toContain('入力 10 /');
  });
});
