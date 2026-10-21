import { describe, expect, it } from 'vitest';

import { verifyJournalStoreConversationIdsAfterContract } from './journal-conversation-ids-after-contract.js';
import { createMemoryStores } from './testing.js';
import type { JournalCursor, JournalStore } from './store.js';

type Subject = Parameters<typeof verifyJournalStoreConversationIdsAfterContract>[0];

// 契約の歯を測る: 壊した口を `conversationIdsAfter` に差し込み、契約が落ちることを見る
function withBrokenIdsAfter(
  stores: ReturnType<typeof createMemoryStores>,
  idsAfter: (
    journal: JournalStore,
    query: { after: JournalCursor; until?: string },
  ) => Promise<string[]>,
): Subject {
  return {
    append: stores.journal.append.bind(stores.journal),
    listPage: stores.journal.listPage.bind(stores.journal),
    conversationIdsAfter: (query) => idsAfter(stores.journal, query),
  };
}

async function humanIdsFrom(
  journal: JournalStore,
  query: { after: JournalCursor; until?: string },
  skipAnchor: 'drop' | 'keep',
): Promise<string[]> {
  const rows = await journal.list({
    types: ['exchange'],
    with: ['human'],
    order: 'asc',
    ...(query.until === undefined ? {} : { until: query.until }),
  });
  const from = rows.findIndex((row) => row.id === query.after.id);
  return [
    ...new Set(
      rows
        .slice(skipAnchor === 'drop' ? from + 1 : from)
        .flatMap((row) =>
          row.type === 'exchange' && row.conversationId !== undefined ? [row.conversationId] : [],
        ),
    ),
  ];
}

describe('verifyJournalStoreConversationIdsAfterContract（インメモリ）', () => {
  it('インメモリは契約を満たす', async () => {
    const stores = createMemoryStores();
    await expect(
      verifyJournalStoreConversationIdsAfterContract(stores.journal),
    ).resolves.toBeUndefined();
  });

  it('口を持たない器は契約の破れとして落とす', async () => {
    const stores = createMemoryStores();
    await expect(
      verifyJournalStoreConversationIdsAfterContract({
        append: stores.journal.append.bind(stores.journal),
        listPage: stores.journal.listPage.bind(stores.journal),
      }),
    ).rejects.toThrow('conversationIdsAfter を持っていない');
  });

  it('錨の行そのものを含める実装は落ちる', async () => {
    const stores = createMemoryStores();
    const subject = withBrokenIdsAfter(stores, (journal, query) =>
      humanIdsFrom(journal, query, 'keep'),
    );
    await expect(verifyJournalStoreConversationIdsAfterContract(subject)).rejects.toThrow(
      '錨より後ろ',
    );
  });

  it('他の相手（manager・self）の会話 id まで返す実装は落ちる', async () => {
    const stores = createMemoryStores();
    const subject = withBrokenIdsAfter(stores, async (journal, query) => {
      const rows = await journal.list({ types: ['exchange'], order: 'asc', after: query.after });
      return [
        ...new Set(
          rows.flatMap((row) =>
            row.type === 'exchange' && row.conversationId !== undefined ? [row.conversationId] : [],
          ),
        ),
      ];
    });
    await expect(verifyJournalStoreConversationIdsAfterContract(subject)).rejects.toThrow(
      '錨より後ろ',
    );
  });

  it('until で切らない実装は落ちる', async () => {
    const stores = createMemoryStores();
    const subject = withBrokenIdsAfter(stores, (journal, query) =>
      humanIdsFrom(journal, { after: query.after }, 'drop'),
    );
    await expect(verifyJournalStoreConversationIdsAfterContract(subject)).rejects.toThrow('until');
  });

  it('同じ会話を重ねて返す実装は落ちる', async () => {
    const stores = createMemoryStores();
    const subject = withBrokenIdsAfter(stores, async (journal, query) => {
      const rows = await journal.list({
        types: ['exchange'],
        with: ['human'],
        order: 'asc',
        after: query.after,
        ...(query.until === undefined ? {} : { until: query.until }),
      });
      return rows.flatMap((row) =>
        row.type === 'exchange' && row.conversationId !== undefined ? [row.conversationId] : [],
      );
    });
    await expect(verifyJournalStoreConversationIdsAfterContract(subject)).rejects.toThrow('重複');
  });

  it('錨が無いときに例外を投げず空を返す実装は落ちる', async () => {
    const stores = createMemoryStores();
    const subject = withBrokenIdsAfter(stores, async (journal, query) => {
      try {
        return await stores.journal.conversationIdsAfter!(query);
      } catch {
        void journal;
        return [];
      }
    });
    await expect(verifyJournalStoreConversationIdsAfterContract(subject)).rejects.toThrow('錨');
  });
});
