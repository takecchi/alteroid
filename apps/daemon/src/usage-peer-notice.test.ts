import { fakeCloneHost, USAGE_PEER_INPUT_NOTICE } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

function stubCloneHost(): CloneHost {
  return fakeCloneHost({
    managers: { list: async () => [] } as unknown as CloneHost['managers'],
  });
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

async function record(stores: Stores, site: 'session' | 'peer', unreadable?: boolean) {
  await stores.usage.record({
    layer: 'manager',
    site,
    managerId: 'mgr-1',
    date: '2026-10-01',
    at: '2026-10-01T10:00:00.000Z',
    accumulation: 'oneshot',
    snapshot: {
      models: {
        opus: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 0.25,
          ...(unreadable ? { unreadable: { cacheCreationInputTokens: 1 } } : {}),
        },
      },
    },
  });
}

describe('GET /usage の peerNotice', () => {
  it('結果に peer の分が含まれるときだけ載る（Claude だけなら鍵ごと無い）', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await record(stores, 'session');
    expect('peerNotice' in (await getUsage(stores))).toBe(false);

    await record(stores, 'peer', true);
    expect((await getUsage(stores)).peerNotice).toBe(USAGE_PEER_INPUT_NOTICE);
  });

  it('site で peer を絞り落とした結果には載らない（結果に含まれるかで決める）', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await record(stores, 'session');
    await record(stores, 'peer', true);
    expect('peerNotice' in (await getUsage(stores, '?site=session'))).toBe(false);
    expect((await getUsage(stores, '?site=peer')).peerNotice).toBe(USAGE_PEER_INPUT_NOTICE);
  });

  it('peer の行の cacheCreationInputTokens の unreadable が合計と site 別に足されて返る', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await record(stores, 'session');
    await record(stores, 'peer', true);
    const body = (await getUsage(stores)) as {
      breakdown: {
        total: { unreadable?: Record<string, number> };
        bySite: { site: string; totals: { unreadable?: Record<string, number> } }[];
      };
    };
    expect(body.breakdown.total.unreadable?.cacheCreationInputTokens).toBe(1);
    const bySite = Object.fromEntries(body.breakdown.bySite.map((e) => [e.site, e.totals]));
    expect(bySite.peer?.unreadable?.cacheCreationInputTokens).toBe(1);
    expect(bySite.session?.unreadable).toBeUndefined();
  });
});
