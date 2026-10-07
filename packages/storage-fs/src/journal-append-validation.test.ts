import type { JournalEntryInput } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('JournalStore.append() — 形式不正な entry の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const badInput = {
    type: 'exchange',
    with: 'nobody',
    role: 'inbound',
    text: '本文はなんでもよい',
  } as unknown as JournalEntryInput;

  it('append() は with が許可された値でない entry を拒む（throw する）', async () => {
    await expect(stores.journal.append(badInput)).rejects.toThrow();
  });
});
