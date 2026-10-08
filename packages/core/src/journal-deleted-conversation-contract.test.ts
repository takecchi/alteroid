import { describe, expect, it } from 'vitest';

import { verifyJournalStoreDeletedConversationContract } from './journal-deleted-conversation-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalStore` の「消した会話を外す」契約（issue #4218）を、**インメモリ実装**
 * （`testing.ts`）に対して測る。fs は `packages/storage-fs/src/index.test.ts`、pg は
 * `packages/storage-pg/src/index.journal-jobs-schedule.test.ts` に同じ形の歯が在る。
 */
describe('JournalStore の墓標の契約（インメモリ実装）', () => {
  it('墓標の後は list/listPage/get/q/with から外れる／別の会話と墓標は外れない／limit より前に効く／墓標の後の行も外れる', async () => {
    const stores = createMemoryStores();

    await expect(
      verifyJournalStoreDeletedConversationContract(stores.journal),
    ).resolves.toBeUndefined();
  });

  it('歯: 墓標を無視するストアでは契約が落ちる（契約が何も測っていない状態にならない）', async () => {
    const stores = createMemoryStores();
    const ignoring = {
      ...stores.journal,
      // 墓標の外しを持たない実装の代役: 墓標の行を普通の行として積むだけ
      get: async (id: string) => {
        const all = await stores.journal.list();
        return all.find((entry) => entry.id === id) ?? null;
      },
      list: async () => [],
      listPage: async () => ({ entries: [], next: null }),
    };

    await expect(verifyJournalStoreDeletedConversationContract(ignoring)).rejects.toThrow(
      /墓標の契約/,
    );
  });
});
