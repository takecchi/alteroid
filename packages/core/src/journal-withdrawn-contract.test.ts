import { describe, expect, it } from 'vitest';

import { verifyJournalStoreWithdrawnContract } from './journal-withdrawn-contract.js';
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
    };

    await expect(verifyJournalStoreWithdrawnContract(dropping)).rejects.toThrow(
      /取り下げの印の契約/,
    );
  });

  it('歯: 頁の継続を持たない（最初の頁しか読まない）ストアでは契約が落ちる', async () => {
    const stores = createMemoryStores();
    const firstPageOnly = {
      append: stores.journal.append.bind(stores.journal),
      list: (query: Parameters<typeof stores.journal.list>[0]) => {
        return stores.journal.list({ ...query, after: undefined });
      },
    };

    await expect(verifyJournalStoreWithdrawnContract(firstPageOnly)).rejects.toThrow(
      /継続点が進まない/,
    );
  });
});
