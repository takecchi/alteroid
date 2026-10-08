import { describe, expect, it } from 'vitest';

import type { Commitment } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('CommitmentStore.open() — at が ISO 8601 でない entry の扱い（インメモリ実装）', () => {
  const badEntry = {
    id: 'c1',
    at: 'not-a-date',
    origin: 'self',
    body: '何か頼まれた',
  } as unknown as Commitment;

  it('open() は fs / pg と同じく、at が ISO 8601 でない entry を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.commitments.open(badEntry)).rejects.toThrow();
  });
});
