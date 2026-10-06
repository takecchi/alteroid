import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TZ = 'Asia/Tokyo';
});

import { buildActivityDigest } from './digest.js';
import { createMemoryStores } from './testing.js';

const window = {
  since: new Date('2026-10-05T00:00:00+09:00'),
  until: new Date('2026-10-06T00:00:00+09:00'),
};

describe('digest の「使った分」は、消費を取れなかったターンを 0 に見せない', () => {
  it('消費を報告しない provider のターンしか無い期間を「この期間の記録は無い」と書かない', async () => {
    const stores = createMemoryStores();
    await stores.usage.recordUnmetered({
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      date: '2026-10-05',
      at: '2026-10-05T03:00:00.000Z',
      provider: 'codex',
    });
    const text = await buildActivityDigest(stores, window);
    const usage = text.slice(text.indexOf('## 使った分'));
    expect(usage).not.toContain('この期間の記録は無い');
    expect(usage).toContain('codex');
  });

  it('消費の合計の下に、取れなかった provider のターンを書く（usage_read と同じ扱い）', async () => {
    const stores = createMemoryStores();
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-a',
      date: '2026-10-05',
      at: '2026-10-05T03:00:00.000Z',
      snapshot: {
        sessionId: 's-a',
        models: {
          opus: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 0.5,
          },
        },
      },
      accumulation: 'oneshot',
    });
    await stores.usage.recordUnmetered({
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      date: '2026-10-05',
      at: '2026-10-05T03:00:00.000Z',
      provider: 'codex',
    });
    const text = await buildActivityDigest(stores, window);
    const usage = text.slice(text.indexOf('## 使った分'));
    expect(usage).toContain('合計: $0.5000');
    expect(usage).toContain('codex');
  });
});

describe('digest の「使った分」は、読めずに外した台帳の行を黙らない（#2427）', () => {
  it('unreadableRows があれば、合計に入っていないと書く（usage_read と同じ文言）', async () => {
    const stores = createMemoryStores();
    const original = stores.usage.aggregate.bind(stores.usage);
    stores.usage.aggregate = async (query) => ({
      ...(await original(query)),
      unreadableRows: [{ table: 'usage_daily', date: '2026-10-05', fields: ['cost_usd'] }],
    });
    const text = await buildActivityDigest(stores, window);
    const usage = text.slice(text.indexOf('## 使った分'));
    expect(usage).toContain('読めない使用量の行が 1 行あり、合計に入っていない');
    expect(usage).toContain('2026-10-05');
  });
});
