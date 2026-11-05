import { describe, expect, it } from 'vitest';

import { verifyJournalStoreWithdrawnContract } from './journal-withdrawn-contract.js';
import { withdrawnClientMessageIdsFromPages } from './journal-scan.js';
import { createMemoryStores } from './testing.js';

describe('JournalStore の取り下げの印の契約（インメモリ実装）', () => {
  it('印の行が書き戻せ、同じ会話の印だけが集まり、since より前は外れ、頁をまたいでも読み落とさない', async () => {
    const stores = createMemoryStores();

    await expect(verifyJournalStoreWithdrawnContract(stores.journal)).resolves.toBeUndefined();
  });

  it('歯: 印の欄を落とすストアでは契約が落ちる', async () => {
    const stores = createMemoryStores();
    const dropping = {
      append: async (input: Parameters<typeof stores.journal.append>[0]) => {
        const stripped = { ...input } as Record<string, unknown>;
        delete stripped.withdrawnClientMessageId;
        return stores.journal.append(stripped as typeof input);
      },
      list: stores.journal.list.bind(stores.journal),
      withdrawnClientMessageIds: stores.journal.withdrawnClientMessageIds.bind(stores.journal),
    };

    await expect(verifyJournalStoreWithdrawnContract(dropping)).rejects.toThrow(
      /取り下げの印の契約/,
    );
  });

  it('歯: 最初の頁の印しか返さない口では契約が落ちる', async () => {
    const stores = createMemoryStores();
    const firstPageOnly = {
      append: stores.journal.append.bind(stores.journal),
      list: stores.journal.list.bind(stores.journal),
      withdrawnClientMessageIds: (query: { since: string; conversationId?: string }) =>
        withdrawnClientMessageIdsFromPages(
          {
            listPage: (page) => stores.journal.listPage({ ...page, limit: 2, after: undefined }),
          },
          query,
        ),
    };

    await expect(verifyJournalStoreWithdrawnContract(firstPageOnly)).rejects.toThrow(
      /継続点が進まない/,
    );
  });

  it('歯: 同じ会話の印以外（別の会話の印）まで返す口では契約が落ちる', async () => {
    const stores = createMemoryStores();
    const unscoped = {
      append: stores.journal.append.bind(stores.journal),
      list: stores.journal.list.bind(stores.journal),
      withdrawnClientMessageIds: (query: { since: string }) =>
        stores.journal.withdrawnClientMessageIds({ since: query.since }),
    };

    await expect(verifyJournalStoreWithdrawnContract(unscoped)).rejects.toThrow(/絞り/);
  });
});
