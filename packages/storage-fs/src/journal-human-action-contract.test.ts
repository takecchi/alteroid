import { verifyJournalStoreHumanActionContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('JournalStore の decision.humanAction 契約（fs 実装）', () => {
  it('humanAction は追記して読み戻しても欄ごと返り、無い行は印なしのまま読める', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));

    await expect(verifyJournalStoreHumanActionContract(stores.journal)).resolves.toBeUndefined();
  });
});
