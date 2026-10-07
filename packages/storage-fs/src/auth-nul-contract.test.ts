import { verifyAuthNulContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('AuthStore の NUL の契約（fs 実装）', () => {
  it('読むだけの口は「無い」と同じ結果、書き込みは鍵を断り本文を落として残す', async () => {
    const stores = createFsStores(await makeTempDir('alteroid-test-'));
    await expect(verifyAuthNulContract(stores.auth)).resolves.toBeUndefined();
  });
});
