import type { JournalEntryInput } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1668。詳しい経緯とインメモリ側の対の歯は
 * `packages/core/src/journal-append-validation.test.ts` の冒頭コメントを見よ。
 *
 * ここは fs 実装に対して同じ入力を当てる——`append()` が
 * `journalEntrySchema.parse(...)` を通すので、この歯は緑になる。
 */
describe('JournalStore.append() — 形式不正な entry の扱い（fs 実装）', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  const badInput = {
    type: 'exchange',
    with: 'nobody', // journalEntrySchema は with を 'human' | 'manager' | 'self' に限る
    role: 'inbound',
    text: '本文はなんでもよい',
  } as unknown as JournalEntryInput;

  it('append() は with が許可された値でない entry を拒む（throw する）', async () => {
    await expect(stores.journal.append(badInput)).rejects.toThrow();
  });
});
