import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('TokenPoolStore.replace() — order が非整数の AgentToken の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  it('replace() は order が非整数の行を拒む（throw する）', async () => {
    const badToken = { id: 't1', label: 'x', order: 1.5 };
    await expect(stores.tokens.replace([badToken])).rejects.toThrow();
  });
});
