import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1700。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/persona-protection-status-invalid-slug.test.ts` の
 * 冒頭コメントを見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——`protectionStatus` が
 * `memorySlugSchema` の検査を直接通すようになったので、この歯は緑になる。
 */
describe('PersonaStore.protectionStatus() — 形式不正な slug の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const invalidSlug = 'Invalid Slug!';

  it('protectionStatus() は形式不正な slug を拒む（throw する）', async () => {
    await expect(stores.persona.protectionStatus(invalidSlug)).rejects.toThrow();
  });
});
