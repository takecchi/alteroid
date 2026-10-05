import { verifyAuthNulContract } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createPgStoresFromDb } from './index.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/** `AuthStore` の NUL の契約（issue #3011。3実装で同じことを測る）を pg 実装（PGlite）に対して測る。 */
describe('AuthStore の NUL の契約（pg 実装）', () => {
  it('読むだけの口は「無い」と同じ結果、書き込みは鍵を断り本文を落として残す', async () => {
    const { client, db } = await createMigratedPglite();
    try {
      await expect(verifyAuthNulContract(createPgStoresFromDb(db).auth)).resolves.toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
