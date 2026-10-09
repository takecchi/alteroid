import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('PersonaStore.protectionStatus() — 形式不正な slug の扱い（インメモリ実装）', () => {
  const invalidSlug = 'Invalid Slug!';

  it('protectionStatus() は pg と同じく、形式不正な slug を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.persona.protectionStatus(invalidSlug)).rejects.toThrow();
  });
});
