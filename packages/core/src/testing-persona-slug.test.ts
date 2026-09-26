import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

/**
 * **インメモリの `PersonaStore` は、本物（fs の `#path` / pg の `#slug`）と同じ slug の
 * 検査を持つ。** かつてインメモリだけが何でも受け付けたので、クローンの道具へ不正な
 * slug を渡す歯が、本物では例外になる入力を「書けた」として通していた（2026-09-26 の
 * バグ探しで見つけた差）。検査するのは fs と pg の両方が検査するメソッドだけで、
 * 文言も本物と同じである。
 */
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
