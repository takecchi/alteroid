import type { Commitment } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1652。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/commitment-open-validation.test.ts` の冒頭コメントを
 * 見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——`open()` が
 * `commitmentSchema.parse(entry)` を通すので、この歯は緑になる。
 */
describe('CommitmentStore.open() — at が ISO 8601 でない entry の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const badEntry = {
    id: 'c1',
    at: 'not-a-date',
    origin: 'self',
    body: '何か頼まれた',
  } as unknown as Commitment;

  it('open() は at が ISO 8601 でない entry を拒む（throw する）', async () => {
    await expect(stores.commitments.open(badEntry)).rejects.toThrow();
  });
});
