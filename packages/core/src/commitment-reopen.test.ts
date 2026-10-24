import { describe, expect, it } from 'vitest';

import { describeClosedRecord, reopenCommitmentJournalFirst } from './commitment-reopen.js';
import type { ManagerPool } from './manager.js';
import type { Commitment, JournalEntryInput } from './schema.js';
import { UnreadableCommitmentError } from './store.js';
import type { CommitmentStore, Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: {} as unknown as ManagerPool,
  });
  return {
    stores,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

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

describe('commitment_reopen（#5176）', () => {
  it('閉じた行を未了へ戻し、開き直す前の閉じた記録を日誌へ逐語で残す', async () => {
    const h = harness();
    await closedRow(h.stores);
    const out = await h.call('commitment_reopen', { id: 'c1', reason: 'まだ終わっていない' });
    expect(out).toContain('開き直した');
    const row = await h.stores.commitments.get('c1');
    expect(row?.closedAt).toBeUndefined();
    expect(row?.autoCloseWhenBack).toBeUndefined();
    expect(row?.at).toBe(AT);
    const rows = await h.stores.journal.list({ types: ['decision'] });
    const text = JSON.stringify(rows);
    expect(text).toContain('まだ終わっていない');
    expect(text).toContain(`closedAt=${CLOSED_AT}`);
    expect(text).toContain('closedBy=daemon');
    expect(text).toContain('closedReason=器が閉じた');
  });

  it('未了の行は何もせず日誌にも残さない', async () => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'self', body: '本文' });
    const out = await h.call('commitment_reopen', { id: 'c1', reason: '戻す' });
    expect(out).toContain('閉じていない');
    const rows = await h.stores.journal.list({ types: ['decision'] });
    expect(JSON.stringify(rows)).not.toContain('開き直した');
  });

  it.each([' ', '\t\n', ''])('reason %j は断り、開き直さない', async (reason) => {
    const h = harness();
    await closedRow(h.stores);
    const out = await h.call('commitment_reopen', { id: 'c1', reason });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.commitments.get('c1'))?.closedAt).toBe(CLOSED_AT);
  });

  it('同じ担当・同じ本文の未了の行が在れば、開き直さずその id を言う', async () => {
    const h = harness();
    const base = { at: AT, origin: 'manager', source: 'mgr-1', body: '同じ本文' } as const;
    await h.stores.commitments.open({ ...base, id: 'old' });
    await h.stores.commitments.close('old', CLOSED_AT, '片付けた', 'clone');
    await h.stores.commitments.open({ ...base, id: 'new' });
    const out = await h.call('commitment_reopen', { id: 'old', reason: '戻す' });
    expect(out).toContain('new');
    expect(out).toContain('開き直していない');
    expect((await h.stores.commitments.get('old'))?.closedAt).toBe(CLOSED_AT);
  });

  it('無い id は台帳に無いと言う', async () => {
    const h = harness();
    const out = await h.call('commitment_reopen', { id: 'nope', reason: '戻す' });
    expect(out).toContain('台帳に');
  });

  it('読めない行は書き直さず、開き直していないと言う（先読みの時点。日誌も書かない）', async () => {
    const h = harness();
    const unreadable: CommitmentStore = {
      ...h.stores.commitments,
      async get() {
        throw new UnreadableCommitmentError('引き受けた仕事 c1 が読めない形で入っている');
      },
    };
    const tools = createCloneTools({
      stores: { ...h.stores, commitments: unreadable },
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
      managers: {} as unknown as ManagerPool,
    });
    const found = tools.find((entry) => entry.name === 'commitment_reopen');
    const result = await found?.handler({ id: 'c1', reason: '戻す' } as never, {});
    const out = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(out).toContain('開き直していない');
    expect(await h.stores.journal.list({ types: ['decision'] })).toEqual([]);
  });

  it('読めない行は書き直さず、開き直していないと言う（先読みの後に読めなくなった。打ち消しの行を足す）', async () => {
    const h = harness();
    await closedRow(h.stores);
    const unreadable: CommitmentStore = {
      ...h.stores.commitments,
      async reopen() {
        throw new UnreadableCommitmentError('引き受けた仕事 c1 が読めない形で入っている');
      },
    };
    const tools = createCloneTools({
      stores: { ...h.stores, commitments: unreadable },
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
      managers: {} as unknown as ManagerPool,
    });
    const found = tools.find((entry) => entry.name === 'commitment_reopen');
    const result = await found?.handler({ id: 'c1', reason: '戻す' } as never, {});
    const out = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(out).toContain('開き直していない');
    expect(JSON.stringify(await h.stores.journal.list({ types: ['decision'] }))).toContain(
      '直前の開き直しの行は効いていない（開き直していない）',
    );
  });

  it('日誌に書けないときは開き直さず（行は閉じたまま）、開き直していないと投げる', async () => {
    const h = harness();
    await closedRow(h.stores);
    const failing = failingJournal(h.stores);
    const tools = createCloneTools({
      stores: failing,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
      managers: {} as unknown as ManagerPool,
    });
    const found = tools.find((entry) => entry.name === 'commitment_reopen');
    await expect(found?.handler({ id: 'c1', reason: '戻す' } as never, {})).rejects.toThrow(
      '行為は起きていない',
    );
    const row = await h.stores.commitments.get('c1');
    expect(row?.closedAt).toBe(CLOSED_AT);
    expect(row?.closedBy).toBe('daemon');
    expect(row?.closedReason).toBe('器が閉じた');
  });
});

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
