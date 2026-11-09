import { createTokenPoolService, fakeCloneHost } from '@alteroid/core';
import type { CloneHost, ManagerSummary } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

const AUTH = { authorization: 'Bearer test-token' };
const DUMMY_VALUE = 'dummy-token-value-never-respond';

function summary(overrides: Partial<ManagerSummary>): ManagerSummary {
  return {
    managerId: 'mgr-x',
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    waiting: [],
    ...overrides,
  } as ManagerSummary;
}

async function usedByOf(options: {
  list: () => Promise<ManagerSummary[]>;
  cloneTokenId?: () => string | undefined;
}) {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.tokens.replace([
    { id: 'tok-a', label: 'a', value: DUMMY_VALUE, source: 'stored', order: 0 },
    { id: 'tok-b', label: 'b', value: DUMMY_VALUE, source: 'stored', order: 1 },
  ]);
  const app = createApp({
    clone: fakeCloneHost({ managers: { list: options.list } as unknown as CloneHost['managers'] }),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    tokens: createTokenPoolService({ stores }),
    ...(options.cloneTokenId === undefined ? {} : { cloneTokenId: options.cloneTokenId }),
  });
  const response = await app.request('/tokens', { headers: AUTH });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(DUMMY_VALUE);
  return (JSON.parse(text) as { usedBy?: unknown }).usedBy;
}

describe('GET /tokens の usedBy: いまその鍵で動いている担当（#6646）', () => {
  it('クローンと、進行中の委譲（走っている・返事待ち）を鍵ごとに返す', async () => {
    const usedBy = await usedByOf({
      cloneTokenId: () => 'tok-b',
      list: async () => [
        summary({ managerId: 'mgr-run', tokenId: 'tok-a' }),
        summary({ managerId: 'mgr-wait', status: 'waiting_human', live: false, tokenId: 'tok-b' }),
      ],
    });
    expect(usedBy).toEqual([
      { tokenId: 'tok-b', kind: 'clone' },
      { tokenId: 'tok-a', kind: 'manager', managerId: 'mgr-run' },
      { tokenId: 'tok-b', kind: 'manager', managerId: 'mgr-wait' },
    ]);
  });

  it('終わった委譲・セッションの無い running・鍵が分からない委譲は載せない', async () => {
    const usedBy = await usedByOf({
      list: async () => [
        summary({ managerId: 'mgr-done', status: 'done', tokenId: 'tok-a' }),
        summary({ managerId: 'mgr-not-live', live: false, tokenId: 'tok-a' }),
        summary({ managerId: 'mgr-unknown' }),
      ],
    });
    expect(usedBy).toEqual([]);
  });

  it('委譲の一覧が読めなければ欄ごと出さない（空配列で「誰も使っていない」と言わない）。鍵の一覧は返る', async () => {
    const usedBy = await usedByOf({
      cloneTokenId: () => 'tok-a',
      list: () => Promise.reject(new Error('台帳が読めない')),
    });
    expect(usedBy).toBeUndefined();
  });
});
