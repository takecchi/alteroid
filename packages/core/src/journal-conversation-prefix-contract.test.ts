import { describe, expect, it } from 'vitest';

import { verifyJournalStoreConversationPrefixContract } from './journal-conversation-prefix-contract.js';
import { createMemoryStores } from './testing.js';

describe('verifyJournalStoreConversationPrefixContract（インメモリ）', () => {
  it('インメモリは契約を満たす', async () => {
    const stores = createMemoryStores();
    await expect(
      verifyJournalStoreConversationPrefixContract(stores.journal),
    ).resolves.toBeUndefined();
  });

  it('上限で切らない実装は落ちる', async () => {
    const stores = createMemoryStores();
    const subject = {
      append: stores.journal.append.bind(stores.journal),
      conversationIdsWithPrefix: (query: { prefix: string; limit: number }) =>
        stores.journal.conversationIdsWithPrefix({ ...query, limit: 100 }),
    };
    await expect(verifyJournalStoreConversationPrefixContract(subject)).rejects.toThrow('上限');
  });

  it('消した会話・他の相手の会話 id まで返す実装は落ちる', async () => {
    const stores = createMemoryStores();
    const subject = {
      append: stores.journal.append.bind(stores.journal),
      conversationIdsWithPrefix: async (query: { prefix: string; limit: number }) => {
        const rows = await stores.journal.list({ types: ['exchange'] });
        return [
          ...new Set(
            rows.flatMap((row) =>
              row.type === 'exchange' && row.conversationId?.startsWith(query.prefix) === true
                ? [row.conversationId]
                : [],
            ),
          ),
        ].slice(0, query.limit);
      },
    };
    await expect(verifyJournalStoreConversationPrefixContract(subject)).rejects.toThrow(
      /前方一致の契約/,
    );
  });
});
