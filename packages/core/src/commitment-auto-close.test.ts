import { describe, expect, it } from 'vitest';

import { closeCommitmentJournalFirst } from './commitment-auto-close.js';
import type { JournalEntryInput } from './schema.js';
import { UnreadableCommitmentError } from './store.js';
import type { CommitmentStore } from './store.js';
import { createMemoryStores } from './testing.js';

const AT = '2026-10-07T00:00:00.000Z';
const entry: JournalEntryInput = {
  type: 'decision',
  decision: '行を器が自動で閉じる（c1）',
  grounds: '担当が戻っていた',
};
const input = { reason: '器が自動で閉じた: テスト', entry };

async function openRow(stores: ReturnType<typeof createMemoryStores>) {
  await stores.commitments.open({
    id: 'c1',
    at: AT,
    origin: 'manager',
    source: 'mgr-1',
    body: '本文',
    autoCloseWhenBack: { managerId: 'mgr-1' },
  });
}

type Stores = ReturnType<typeof createMemoryStores>;

function withJournal(stores: Stores, append: (e: JournalEntryInput) => Promise<unknown>): Stores {
  return { ...stores, journal: { ...stores.journal, append } } as unknown as Stores;
}

// 先読み（`get`）の後、`close` の直前に割り込みを差し込む
function interruptClose(stores: Stores, interrupt: () => Promise<void>): Stores {
  return {
    ...stores,
    commitments: {
      ...stores.commitments,
      async close(...args: Parameters<CommitmentStore['close']>) {
        await interrupt();
        return stores.commitments.close(...args);
      },
    },
  } as unknown as Stores;
}

async function decisionTexts(stores: Stores): Promise<string> {
  return JSON.stringify(await stores.journal.list({ types: ['decision'] }));
}

describe('closeCommitmentJournalFirst（#5235）', () => {
  it('日誌の行は、台帳の行がまだ開いているうちに書かれ、その後に closedBy daemon で閉じる', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    const closedAtAppend: (string | undefined)[] = [];
    const spied = withJournal(stores, async (e) => {
      closedAtAppend.push((await stores.commitments.get('c1'))?.closedAt);
      return stores.journal.append(e);
    });

    const result = await closeCommitmentJournalFirst(spied, 'c1', input);

    expect(result.kind).toBe('closed');
    expect(closedAtAppend).toEqual([undefined]);
    const row = await stores.commitments.get('c1');
    expect(row?.closedBy).toBe('daemon');
    expect(row?.closedReason).toBe(input.reason);
    expect(await decisionTexts(stores)).toContain('行を器が自動で閉じる（c1）');
  });

  it('日誌に書けなければ閉じず（行は未了のまま）、journal-failed を返す。日誌が戻れば次の機会に閉じる', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    const down = withJournal(stores, async () => {
      throw new Error('journal down');
    });

    const failed = await closeCommitmentJournalFirst(down, 'c1', input);

    expect(failed.kind).toBe('journal-failed');
    expect((await stores.commitments.get('c1'))?.closedAt).toBeUndefined();

    const retried = await closeCommitmentJournalFirst(stores, 'c1', input);
    expect(retried.kind).toBe('closed');
    expect((await stores.commitments.get('c1'))?.closedBy).toBe('daemon');
  });

  it.each(['無い行', '既に閉じた行'])('%s は日誌を書かず not-open を返す', async (which) => {
    const stores = createMemoryStores();
    if (which === '既に閉じた行') {
      await openRow(stores);
      await stores.commitments.close('c1', AT, '人間が閉じた', 'human');
    }
    const result = await closeCommitmentJournalFirst(stores, 'c1', input);
    expect(result.kind).toBe('not-open');
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
  });

  it('読めない行は閉じず、日誌も書かず、unreadable を返す', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    const unreadable = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async get(): Promise<never> {
          throw new UnreadableCommitmentError('引き受けた仕事 c1 が読めない形で入っている');
        },
      },
    } as unknown as Stores;
    const result = await closeCommitmentJournalFirst(unreadable, 'c1', input);
    expect(result.kind).toBe('unreadable');
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
    expect((await stores.commitments.get('c1'))?.closedAt).toBeUndefined();
  });

  it('日誌を書いた後に別の手で閉じられたら、打ち消しの行を足して interrupted を返す', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    const raced = interruptClose(stores, async () => {
      await stores.commitments.close('c1', AT, '人間が閉じた', 'human');
    });

    const result = await closeCommitmentJournalFirst(raced, 'c1', input);

    expect(result.kind).toBe('interrupted');
    const row = await stores.commitments.get('c1');
    expect(row?.closedBy).toBe('human');
    const text = await decisionTexts(stores);
    expect(text).toContain('行を器が自動で閉じる（c1）');
    expect(text).toContain('直前の自動クローズの行は効いていない（閉じていない）');
  });

  it('打ち消しの行も書けなければ、interrupted をそのまま返す', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    let appended = 0;
    const raced = interruptClose(
      withJournal(stores, async (e) => {
        appended += 1;
        if (appended > 1) throw new Error('journal down');
        return stores.journal.append(e);
      }),
      async () => {
        await stores.commitments.close('c1', AT, '人間が閉じた', 'human');
      },
    );

    const result = await closeCommitmentJournalFirst(raced, 'c1', input);

    expect(result.kind).toBe('interrupted');
    expect(appended).toBe(2);
  });
});
