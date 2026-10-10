import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyJournalStoreDeletedConversationContract } from './journal-deleted-conversation-contract.js';
import { createMemoryStores } from './testing.js';

/**
 * `JournalStore` の「消した会話を外す」契約（issue #4218）を、**インメモリ実装**
 * （`testing.ts`）に対して測る。fs は `packages/storage-fs/src/index.test.ts`、pg は
 * `packages/storage-pg/src/index.journal-jobs-schedule.test.ts` に同じ形の歯が在る。
 */
describe('JournalStore の墓標の契約（インメモリ実装）', () => {
  it('墓標の後は list/listPage/get/q/with から外れる／別の会話と墓標は外れない／limit より前に効く／墓標の後の行も外れる／墓標が名指しした行も外れる（#4355）', async () => {
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

describe('oldestAt は消した会話の発言の時刻を返さない（#4377）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('最古の行が消した会話の発言なら、見えている行の最古の時刻を返す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const stores = createMemoryStores();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '消す会話の最初の発言',
      conversationId: 'c-deleted',
    });
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '残る会話',
      conversationId: 'c-kept',
    });
    expect(await stores.journal.oldestAt()).toBe('2026-10-01T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
    await stores.journal.append({
      type: 'conversation_deleted',
      deletedConversationId: 'c-deleted',
      deletedBy: 'operator',
      hiddenCount: 1,
    });
    expect(await stores.journal.oldestAt()).toBe('2026-10-02T00:00:00.000Z');
  });
});
