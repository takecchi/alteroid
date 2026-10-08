import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('JournalStore の decision.target（やり方の書き込みの印、#4065、fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    stores = createFsStores(await makeTempDir('alteroid-test-'));
  });

  it('target は追記して読み戻しても落ちず、無い行は印なしのまま読める', async () => {
    await stores.journal.append({ type: 'decision', decision: '印なし', grounds: '古い行の形' });
    await stores.journal.append({
      type: 'decision',
      decision: '印あり',
      grounds: '新しい行の形',
      target: { kind: 'practice', slug: 'daily' },
    });

    const entries = await stores.journal.list({ types: ['decision'], order: 'asc' });
    expect(entries).toHaveLength(2);
    expect(entries[0]).not.toHaveProperty('target');
    expect(entries[1]).toMatchObject({ target: { kind: 'practice', slug: 'daily' } });
  });
});
