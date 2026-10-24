import type { CloneHost, JournalEntry, Stores } from '@alteroid/core';
import { captureStderr, createMemoryStores, ScheduleConflictError } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// #5234: 人間の DELETE /schedule/:kind は、外す前に日誌へ残す。印（humanAction）は効いた後の行だけに付ける。

const SEEN = '2026-10-01T00:00:00.000Z';
const spec = { type: 'daily', at: '09:00' } as const;
const KIND = 'morning';

function stubClone(): CloneHost {
  return {
    post: () => 'conversation-1',
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: {},
  } as unknown as CloneHost;
}

function appOver(stores: Stores) {
  return createApp({
    clone: stubClone(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
}

function remove(app: ReturnType<typeof createApp>, body?: unknown) {
  return app.request(`/schedule/${KIND}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function decisions(stores: Stores): Promise<(JournalEntry & { type: 'decision' })[]> {
  const rows = await stores.journal.list({ types: ['decision'], order: 'asc' });
  return rows.filter((row): row is JournalEntry & { type: 'decision' } => row.type === 'decision');
}

describe('DELETE /schedule/:kind は日誌を先に書く（#5234）', () => {
  let stores: Stores;

  beforeEach(async () => {
    stores = createMemoryStores();
    await stores.schedules.put({
      kind: KIND,
      spec,
      request: '人間が見た本文',
      createdAt: SEEN,
      updatedAt: SEEN,
    });
  });

  it('外す瞬間に、先の行が日誌に既に在る。先の行には humanAction が無い（順序の歯）', async () => {
    const real = stores.schedules;
    let atRemove: (JournalEntry & { type: 'decision' })[] | undefined;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind, options) {
        atRemove = await decisions(stores);
        return real.removeIfPresent(kind, options);
      },
    };

    const response = await remove(appOver(stores));

    expect(response.status).toBe(200);
    expect(atRemove).toHaveLength(1);
    expect(atRemove?.[0]?.decision).toBe(`人間が定期の依頼を外す: ${KIND}: 人間が見た本文`);
    expect(atRemove?.[0]?.humanAction).toBeUndefined();
  });

  it('効いた後の行だけに humanAction が付く', async () => {
    const response = await remove(appOver(stores));

    expect(response.status).toBe(200);
    const rows = await decisions(stores);
    expect(rows.map((row) => row.humanAction?.kind)).toEqual([undefined, 'schedule_remove']);
    expect(rows[1]?.decision).toBe(`人間が定期の依頼を外した: ${KIND}: 人間が見た本文`);
  });

  it('日誌に書けないとき外さず 500（行が残る）', async () => {
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => {
          throw new Error('journal store unavailable (test)');
        },
      },
    };

    let status = 0;
    await captureStderr(async () => {
      status = (await remove(appOver(failing))).status;
    });

    expect(status).toBe(500);
    expect((await stores.schedules.get(KIND))?.request).toBe('人間が見た本文');
  });

  it('無い kind は 404 で、日誌を書かない', async () => {
    const response = await app404(stores);
    expect(response.status).toBe(404);
    expect(await decisions(stores)).toEqual([]);
  });

  it('割り込みで消えていたら 404 で、打ち消しの行が足され、印は付かない', async () => {
    const real = stores.schedules;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind, options) {
        await real.remove(kind);
        return real.removeIfPresent(kind, options);
      },
    };

    const response = await remove(appOver(stores));

    expect(response.status).toBe(404);
    const rows = await decisions(stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.decision).toContain('効いていない');
    expect(rows.every((row) => row.humanAction === undefined)).toBe(true);
  });

  it('割り込みで版が合わなくなったら 409 で、打ち消しの行が足され、印は付かない', async () => {
    const real = stores.schedules;
    stores.schedules = {
      ...real,
      async removeIfPresent(kind) {
        throw new ScheduleConflictError(kind, null);
      },
    };

    const response = await remove(appOver(stores), { ifMatch: SEEN });

    expect(response.status).toBe(409);
    const rows = await decisions(stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.decision).toContain('効いていない');
    expect(rows.every((row) => row.humanAction === undefined)).toBe(true);
    expect((await real.get(KIND))?.request).toBe('人間が見た本文');
  });

  it('読む前に版が合わないと分かる ifMatch は、日誌を書かずに 409', async () => {
    const response = await remove(appOver(stores), { ifMatch: '2000-01-01T00:00:00.000Z' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ current: { request: '人間が見た本文' } });
    expect(await decisions(stores)).toEqual([]);
    expect(await stores.schedules.get(KIND)).not.toBeNull();
  });
});

async function app404(stores: Stores): Promise<Response> {
  return appOver(stores).request('/schedule/nope', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
  });
}
