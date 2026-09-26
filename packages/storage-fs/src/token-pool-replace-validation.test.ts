import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/token-pool-replace-validation.test.ts` の冒頭コメントを
 * 見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——`replace()` が
 * `agentTokenRowSchema.parse(token)`（`order: z.number().int()`。いまは
 * `@alteroid/core` の `agentTokenSchema` を `.extend()` したもの）を通すので、
 * この歯は緑になる。
 */
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
