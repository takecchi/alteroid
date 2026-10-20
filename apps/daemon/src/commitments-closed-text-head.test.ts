import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { COMMITMENT_LIST_TEXT_HEAD, createApp } from './app.js';

// GET /commitments（一覧）は片付いた行の本文・閉じた理由を先頭に切り、全文は GET /commitments/:id で返す（#5089）

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

type Row = {
  id: string;
  body: string;
  bodyTruncated?: true;
  closedReason?: string;
  closedReasonTruncated?: true;
  updatedAt: string;
};

async function get(stores: Stores, path: string): Promise<{ status: number; body: unknown }> {
  const app = createApp({
    clone: cloneOver(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
  const response = await app.request(path, { headers: { authorization: 'Bearer test-token' } });
  return { status: response.status, body: await response.json() };
}

async function listRows(stores: Stores): Promise<Row[]> {
  const { status, body } = await get(stores, '/commitments?includeClosed=true');
  expect(status).toBe(200);
  return (body as { entries: Row[] }).entries;
}

const OPENED_AT = '2026-09-01T00:00:00.000Z';
const CLOSED_AT = '2026-09-02T00:00:00.000Z';

async function openRow(stores: Stores, id: string, body: string): Promise<void> {
  await stores.commitments.open({ id, at: OPENED_AT, origin: 'human', body });
}

async function closeRow(stores: Stores, id: string, reason: string): Promise<void> {
  await stores.commitments.close(id, CLOSED_AT, reason, 'human');
}

const LONG_BODY = '頼まれた本文。'.repeat(100);
const LONG_REASON = '片付けた理由。'.repeat(100);

describe('GET /commitments は片付いた行だけ本文と閉じた理由を先頭に切る（#5089）', () => {
  it('⭐ 片付いた行は先頭に切って「…」と印を付け、詳細では全文を返す', async () => {
    const stores = createMemoryStores();
    await openRow(stores, 'c-closed', LONG_BODY);
    await closeRow(stores, 'c-closed', LONG_REASON);

    const [row] = await listRows(stores);
    expect(row?.body).toBe(`${LONG_BODY.slice(0, COMMITMENT_LIST_TEXT_HEAD)}…`);
    expect(row?.bodyTruncated).toBe(true);
    expect(row?.closedReason).toBe(`${LONG_REASON.slice(0, COMMITMENT_LIST_TEXT_HEAD)}…`);
    expect(row?.closedReasonTruncated).toBe(true);

    const detail = await get(stores, '/commitments/c-closed');
    expect(detail.status).toBe(200);
    const entry = (detail.body as { entry: Row }).entry;
    expect(entry.body).toBe(LONG_BODY);
    expect(entry.closedReason).toBe(LONG_REASON);
    expect(entry).not.toHaveProperty('bodyTruncated');
    expect(entry.updatedAt).toBe(row?.updatedAt);
  });

  it('⭐ 未了の行は長くても切らない（編集の初期値・版の取り込みに一覧の本文を使うため）', async () => {
    const stores = createMemoryStores();
    await openRow(stores, 'c-open', LONG_BODY);

    const [row] = await listRows(stores);
    expect(row?.body).toBe(LONG_BODY);
    expect(row).not.toHaveProperty('bodyTruncated');
  });

  it('短い片付いた行は切らず、印も付けない', async () => {
    const stores = createMemoryStores();
    await openRow(stores, 'c-short', '短い');
    await closeRow(stores, 'c-short', '済んだ');

    const [row] = await listRows(stores);
    expect(row?.body).toBe('短い');
    expect(row?.closedReason).toBe('済んだ');
    expect(row).not.toHaveProperty('bodyTruncated');
    expect(row).not.toHaveProperty('closedReasonTruncated');
  });

  it('切れ目をまたぐ鍵は、頭だけが生で残らない', async () => {
    const stores = createMemoryStores();
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    await openRow(
      stores,
      'c-secret',
      `${'x'.repeat(COMMITMENT_LIST_TEXT_HEAD - 10)} ${token} ${'y'.repeat(300)}`,
    );
    await closeRow(stores, 'c-secret', '済んだ');

    const [row] = await listRows(stores);
    expect(row?.bodyTruncated).toBe(true);
    expect(row?.body).not.toContain('ghp_');
  });

  it('詳細: 無い id は 404', async () => {
    const stores = createMemoryStores();
    expect(await get(stores, '/commitments/nope')).toEqual({
      status: 404,
      body: { error: 'not found' },
    });
  });
});
