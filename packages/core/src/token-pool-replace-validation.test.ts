import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('TokenPoolStore.replace() — order が非整数の AgentToken の扱い（インメモリ実装）', () => {
  it('replace() は fs / pg と同じく、order が非整数の行を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    const badToken = { id: 't1', label: 'x', order: 1.5 };
    await expect(stores.tokens.replace([badToken])).rejects.toThrow();
  });
});
