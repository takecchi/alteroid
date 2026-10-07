import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

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
