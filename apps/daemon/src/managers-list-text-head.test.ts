import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, Job, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp, MANAGER_LIST_TEXT_HEAD } from './app.js';

// GET /managers（一覧）は依頼文と報告を先頭だけに切り、全文は GET /managers/:id で返す（#5089）

function cloneOver(stores: Stores): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

function job(id: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'done',
    summary: `${id} の要約`,
    request: `${id} の依頼`,
    ...extra,
  };
}

type Row = {
  managerId: string;
  request: string;
  requestTruncated?: true;
  lastReport?: string;
  lastReportTruncated?: true;
};

async function getJson<T>(stores: Stores, path: string): Promise<T> {
  const app = createApp({
    clone: cloneOver(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request(path, { headers: { authorization: 'Bearer test-token' } });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function listRow(stores: Stores, id: string): Promise<Row> {
  const body = await getJson<{ managers: Row[] }>(stores, '/managers');
  const row = body.managers.find((entry) => entry.managerId === id);
  if (row === undefined) throw new Error(`${id} が一覧に無い`);
  return row;
}

describe('GET /managers は依頼文と報告を先頭だけに切る（#5089）', () => {
  it('⭐ 長い依頼文・報告は一覧では先頭に切って「…」と印を付け、詳細では全文を返す', async () => {
    const stores = createMemoryStores();
    const request = '依頼の本文。'.repeat(400);
    const lastReport = '報告の本文。'.repeat(500);
    await stores.jobs.putJob(
      job('mgr-long', {
        request,
        lastReport,
        lastReportAt: '2026-09-01T01:00:00.000Z',
        lastReportStatus: 'done',
      }),
    );

    const row = await listRow(stores, 'mgr-long');
    expect(row.request).toBe(`${request.slice(0, MANAGER_LIST_TEXT_HEAD)}…`);
    expect(row.requestTruncated).toBe(true);
    expect(row.lastReport).toBe(`${lastReport.slice(0, MANAGER_LIST_TEXT_HEAD)}…`);
    expect(row.lastReportTruncated).toBe(true);

    const detail = await getJson<{ manager: Row }>(stores, '/managers/mgr-long');
    expect(detail.manager.request).toBe(request);
    expect(detail.manager.lastReport).toBe(lastReport);
    expect(detail.manager).not.toHaveProperty('requestTruncated');
    expect(detail.manager).not.toHaveProperty('lastReportTruncated');
  });

  it('短いものはそのまま返し、印を付けない。報告の無い委譲は一覧でも報告の欄を持たない', async () => {
    const stores = createMemoryStores();
    const exactly = 'あ'.repeat(MANAGER_LIST_TEXT_HEAD);
    await stores.jobs.putJob(job('mgr-short', { request: exactly }));

    const row = await listRow(stores, 'mgr-short');
    expect(row.request).toBe(exactly);
    expect(row).not.toHaveProperty('requestTruncated');
    expect(row).not.toHaveProperty('lastReport');
    expect(row).not.toHaveProperty('lastReportTruncated');
  });

  it('⭐ 切れ目をまたぐ鍵は、頭だけが生で残らない（表示の側と同じ伏せを掛けてから切る）', async () => {
    const stores = createMemoryStores();
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const request = `${'x'.repeat(MANAGER_LIST_TEXT_HEAD - 10)} ${token} ${'y'.repeat(300)}`;
    await stores.jobs.putJob(job('mgr-secret', { request }));

    const row = await listRow(stores, 'mgr-secret');
    expect(row.requestTruncated).toBe(true);
    expect(row.request).not.toContain('ghp_');
    expect(row.request).not.toContain('A1b2C3');
  });

  it('切れ目がサロゲート対の途中にかかっても、壊れた文字を返さない', async () => {
    const stores = createMemoryStores();
    const request = `${'x'.repeat(MANAGER_LIST_TEXT_HEAD - 1)}${'😀'.repeat(10)}`;
    await stores.jobs.putJob(job('mgr-emoji', { request }));

    const row = await listRow(stores, 'mgr-emoji');
    expect(row.request).toBe(`${'x'.repeat(MANAGER_LIST_TEXT_HEAD - 1)}…`);
    // 孤立したサロゲートが無い（`isWellFormed` は tsconfig の lib に無いので正規表現で見る）
    expect(row.request).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});
