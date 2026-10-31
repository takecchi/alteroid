import { describe, expect, it } from 'vitest';

import { describeClosedRecord, reopenCommitmentJournalFirst } from './commitment-reopen.js';
import type { Commitment, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

const AT = '2026-10-07T00:00:00.000Z';
const CLOSED_AT = '2026-10-07T01:00:00.000Z';

async function closedRow(stores: ReturnType<typeof createMemoryStores>) {
  await stores.commitments.open({
    id: 'c1',
    at: AT,
    origin: 'manager',
    source: 'mgr-1',
    body: '本文',
    autoCloseWhenBack: { managerId: 'mgr-1' },
  });
  await stores.commitments.close('c1', CLOSED_AT, '器が閉じた', 'daemon');
}

function failingJournal(stores: ReturnType<typeof createMemoryStores>) {
  return {
    ...stores,
    journal: {
      ...stores.journal,
      async append(): Promise<never> {
        throw new Error('journal down');
      },
    },
  } as unknown as ReturnType<typeof createMemoryStores>;
}

const buildEntry = (before: Commitment): JournalEntryInput => ({
  type: 'decision',
  decision: '開き直した（c1）: 戻す',
  grounds: `開き直す前の記録: ${describeClosedRecord(before)}`,
});

describe('reopenCommitmentJournalFirst（#5176）', () => {
  it('日誌の行は、台帳の行がまだ閉じているうちに書かれる', async () => {
    const stores = createMemoryStores();
    await closedRow(stores);
    const closedAtAppend: (string | undefined)[] = [];
    const spied = {
      ...stores,
      journal: {
        ...stores.journal,
        async append(entry: JournalEntryInput) {
          closedAtAppend.push((await stores.commitments.get('c1'))?.closedAt);
          return stores.journal.append(entry);
        },
      },
    } as unknown as ReturnType<typeof createMemoryStores>;

    const result = await reopenCommitmentJournalFirst(spied, 'c1', buildEntry);

    expect(result.kind).toBe('reopened');
    expect(closedAtAppend).toEqual([CLOSED_AT]);
    expect((await stores.commitments.get('c1'))?.closedAt).toBeUndefined();
  });

  it('日誌に書けなければ journal-failed を返し、行は閉じたまま', async () => {
    const stores = createMemoryStores();
    await closedRow(stores);
    const result = await reopenCommitmentJournalFirst(failingJournal(stores), 'c1', buildEntry);
    expect(result.kind).toBe('journal-failed');
    expect((await stores.commitments.get('c1'))?.closedAt).toBe(CLOSED_AT);
  });

  it.each([
    ['not-found', async () => undefined],
    [
      'not-closed',
      async (s: Stores) =>
        void (await s.commitments.open({ id: 'o', at: AT, origin: 'self', body: 'b' })),
    ],
  ])('先読みで %s なら日誌を書かない', async (kind, setup) => {
    const stores = createMemoryStores();
    await setup(stores);
    const result = await reopenCommitmentJournalFirst(
      stores,
      kind === 'not-found' ? 'nope' : 'o',
      buildEntry,
    );
    expect(result.kind).toBe(kind);
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
  });

  it('先読みの後に別の手で開き直されたら、打ち消しの行を足して not-closed を返す', async () => {
    const stores = createMemoryStores();
    await closedRow(stores);
    const raced = interruptReopen(stores, async () => {
      await stores.commitments.reopen('c1');
    });

    const result = await reopenCommitmentJournalFirst(raced, 'c1', buildEntry);

    expect(result.kind).toBe('not-closed');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('開き直した（c1）: 戻す');
    expect(text).toContain('直前の開き直しの行は効いていない（開き直していない）');
  });

  it('先読みの後に同じ担当・同じ本文の未了の行が開かれたら、打ち消しの行を足して duplicate-open を返す', async () => {
    const stores = createMemoryStores();
    await closedRow(stores);
    const raced = interruptReopen(stores, async () => {
      await stores.commitments.open({
        id: 'c2',
        at: AT,
        origin: 'manager',
        source: 'mgr-1',
        body: '本文',
      });
    });

    const result = await reopenCommitmentJournalFirst(raced, 'c1', buildEntry);

    expect(result).toEqual({ kind: 'duplicate-open', openId: 'c2' });
    expect((await stores.commitments.get('c1'))?.closedAt).toBe(CLOSED_AT);
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('直前の開き直しの行は効いていない（開き直していない）');
    expect(text).toContain('c2');
  });

  it('打ち消しの行も書けなければ、元の結果をそのまま返す', async () => {
    const stores = createMemoryStores();
    await closedRow(stores);
    let appended = 0;
    const raced = interruptReopen(
      {
        ...stores,
        journal: {
          ...stores.journal,
          async append(entry: JournalEntryInput) {
            appended += 1;
            if (appended > 1) throw new Error('journal down');
            return stores.journal.append(entry);
          },
        },
      } as unknown as ReturnType<typeof createMemoryStores>,
      async () => {
        await stores.commitments.reopen('c1');
      },
    );

    const result = await reopenCommitmentJournalFirst(raced, 'c1', buildEntry);

    expect(result.kind).toBe('not-closed');
    expect(appended).toBe(2);
  });

  it('先読みと開き直しの間に閉じ直されたら、実際に外した記録を補いの行へ逐語で残す', async () => {
    const stores = createMemoryStores();
    await closedRow(stores);
    const raced = interruptReopen(stores, async () => {
      await stores.commitments.reopen('c1');
      await stores.commitments.close('c1', '2026-10-07T02:00:00.000Z', '閉じ直した', 'human');
    });

    const result = await reopenCommitmentJournalFirst(raced, 'c1', buildEntry);

    expect(result.kind).toBe('reopened');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('closedAt=2026-10-07T02:00:00.000Z');
    expect(text).toContain('closedBy=human');
    expect(text).toContain('closedReason=閉じ直した');
  });

  it('閉じた記録が先読みと同じなら補いの行は足さない', async () => {
    const stores = createMemoryStores();
    await closedRow(stores);
    await reopenCommitmentJournalFirst(stores, 'c1', buildEntry);
    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(1);
  });
});

// 先読み（`get`）の後、`reopen` の直前に割り込みを差し込む
function interruptReopen(
  stores: ReturnType<typeof createMemoryStores>,
  interrupt: () => Promise<void>,
) {
  return {
    ...stores,
    commitments: {
      ...stores.commitments,
      async reopen(id: string) {
        await interrupt();
        return stores.commitments.reopen(id);
      },
    },
  } as unknown as ReturnType<typeof createMemoryStores>;
}
