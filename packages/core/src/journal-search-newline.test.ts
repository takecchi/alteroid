import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('JournalStore.list の q — 欄の区切りの改行', () => {
  it('q が改行だけでも、探す欄を持たない種別（worker_wait）に当たらない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'worker_wait',
      openedAt: new Date().toISOString(),
      tasks: 1,
      turns: 1,
      byCause: { notification: 0, continuation: 0, input: 0 },
      toolless: 0,
      notifications: 0,
      submits: 0,
      settled: true,
    } as never);

    const found = await stores.journal.list({ q: '\n' });

    expect(found.map((entry) => entry.type)).toEqual([]);
  });
});
