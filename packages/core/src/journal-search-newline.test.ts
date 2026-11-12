import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('JournalStore.list の q — 欄の区切りの改行', () => {
  it('q が改行だけでも、探す欄を持たない種別（http_timing）に当たらない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'http_timing',
      windowStartedAt: new Date().toISOString(),
      windowMs: 0,
      requests: 0,
      routes: [],
      slowest: [],
    });

    const found = await stores.journal.list({ q: '\n' });

    expect(found.map((entry) => entry.type)).toEqual([]);
  });
});
