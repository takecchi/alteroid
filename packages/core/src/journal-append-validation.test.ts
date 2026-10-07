import { describe, expect, it } from 'vitest';

import type { JournalEntryInput } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore.append() — 形式不正な entry の扱い（インメモリ実装）', () => {
  const badInput = {
    type: 'exchange',
    with: 'nobody',
    role: 'inbound',
    text: '本文はなんでもよい',
  } as unknown as JournalEntryInput;

  it('append() は fs / pg と同じく、with が許可された値でない entry を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.journal.append(badInput)).rejects.toThrow();
  });
});
