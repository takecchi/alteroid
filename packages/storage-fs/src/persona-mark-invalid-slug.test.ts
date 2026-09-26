import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1700。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/persona-mark-invalid-slug.test.ts` の冒頭コメントを
 * 見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——`markHumanTouched` /
 * `markCreatedAt` はどちらも、`this.read(slug)` 経由の間接検査ではなく
 * `memorySlugSchema` を直接通すようになったので、この歯は緑になる。
 */
describe('PersonaStore.markHumanTouched() / markCreatedAt() — 形式不正な slug の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const invalidSlug = 'Invalid Slug!';
  const at = new Date().toISOString();

  it('markHumanTouched() は形式不正な slug を拒む（throw する）', async () => {
    await expect(stores.persona.markHumanTouched(invalidSlug, at)).rejects.toThrow();
  });

  it('markCreatedAt() は形式不正な slug を拒む（throw する）', async () => {
    await expect(stores.persona.markCreatedAt(invalidSlug, at)).rejects.toThrow();
  });
});
