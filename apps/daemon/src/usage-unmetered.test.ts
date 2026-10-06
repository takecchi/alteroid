import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * 台帳の「取れなかった」（Issue #486 M7、段 S3）の `GET /usage`。
 *
 * - Claude だけの器（無報告の行が無い）では、応答の鍵が導入前と同じで、`unmeteredRows` は鍵ごと無い
 * - 無報告の provider のターンが在れば `unmeteredRows` が載り、`rows` / `breakdown` / `turnRows` は
 *   無報告を足す前と同じ（合計に混ぜない）
 *
 * CLI と Web は応答を描くだけなので、それぞれ `usage.test.ts` / `usage.test.tsx` が応答の形を差して測る。
 */

const PRE_S3_KEYS = [
  'account',
  'beforeLayers',
  'beforeLedger',
  'beforeTokens',
  'beforeTurns',
  'breakdown',
  'layersSince',
  'notice',
  'rows',
  'since',
  'today',
  'tokensSince',
  'turnRows',
  'turnsSince',
  'unrecordedManagers',
];

async function seedFs(): Promise<Stores> {
  return createFsStores(await makeTempDir('alteroid-test-'));
}

async function seedPg(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  return createPgStoresFromDb(db);
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

async function getUsage(stores: Stores): Promise<Record<string, unknown>> {
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request('/usage', { headers: { authorization: 'Bearer test-token' } });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function recordClaude(stores: Stores): Promise<void> {
  await stores.usage.record({
    layer: 'manager',
    site: 'session',
    managerId: 'mgr-1',
    date: '2026-10-01',
    at: '2026-10-01T10:00:00.000Z',
    accumulation: 'cumulative',
    snapshot: {
      models: {
        opus: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 0.25,
        },
      },
    },
  });
}

beforeAll(async () => {
  await migratedTemplate();
}, 30_000);

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)('GET /usage の無報告の provider（%s 実装。#486 S3）', (_label, seed) => {
  it('Claude だけの器: 応答の鍵が導入前と同じで、unmeteredRows は鍵ごと無い', async () => {
    const stores = await seed();
    await recordClaude(stores);

    const body = await getUsage(stores);
    expect(Object.keys(body).sort()).toEqual(PRE_S3_KEYS);
    expect('unmeteredRows' in body).toBe(false);
  });

  it('無報告のターンが在れば unmeteredRows が載り、rows / breakdown / turnRows は足す前と同じ', async () => {
    const stores = await seed();
    await recordClaude(stores);
    const before = await getUsage(stores);

    await stores.usage.recordUnmetered({
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      date: '2026-10-01',
      at: '2026-10-01T11:00:00.000Z',
      provider: 'codex',
    });

    const { unmeteredRows, ...rest } = await getUsage(stores);
    expect(unmeteredRows).toEqual([
      {
        date: '2026-10-01',
        managerId: 'clone',
        layer: 'clone',
        site: 'session',
        provider: 'codex',
        turns: 1,
        updatedAt: '2026-10-01T11:00:00.000Z',
      },
    ]);
    expect(rest).toEqual(before);
  });
});
