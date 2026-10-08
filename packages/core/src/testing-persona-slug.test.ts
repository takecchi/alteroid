import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

describe('インメモリの PersonaStore は本物と同じ slug の検査を持つ', () => {
  const BAD = 'Not A Valid/Slug!!';

  it.each(['read', 'write', 'append', 'remove'] as const)(
    '%s は不正な slug を本物と同じ文言で断る',
    async (method) => {
      const { persona } = createMemoryStores();
      const call =
        method === 'read' || method === 'remove'
          ? persona[method](BAD)
          : persona[method](BAD, '# 本文\n');
      await expect(call).rejects.toThrow(`記憶のスラッグが不正: ${BAD}`);
    },
  );

  it('正しい slug は今までどおり書けて読める', async () => {
    const { persona } = createMemoryStores();
    await persona.write('values.v2_x-y', '# 価値観\n');
    expect((await persona.read('values.v2_x-y'))?.title).toBe('価値観');
  });
});
