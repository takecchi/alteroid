import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('PersonaStore.markHumanTouched() / markCreatedAt() — 形式不正な slug の扱い（インメモリ実装）', () => {
  const invalidSlug = 'Invalid Slug!';
  const at = new Date().toISOString();

  it('markHumanTouched() は fs / pg と同じく、形式不正な slug を拒む（throw する）ことを期待する', async () => {
    const stores = createMemoryStores();
    await expect(stores.persona.markHumanTouched(invalidSlug, at)).rejects.toThrow();
  });

  it('markCreatedAt() は fs / pg と同じく、形式不正な slug を拒む（throw する）ことを期待する', async () => {
    const stores = createMemoryStores();
    await expect(stores.persona.markCreatedAt(invalidSlug, at)).rejects.toThrow();
  });
});
