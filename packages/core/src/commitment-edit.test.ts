import { describe, expect, it } from 'vitest';

import { editCommitmentBodyJournalFirst } from './commitment-edit.js';
import type { ManagerPool } from './manager.js';
import type { Commitment, JournalEntryInput } from './schema.js';
import { CommitmentConflictError } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

type MemoryStores = ReturnType<typeof createMemoryStores>;

const AT = '2026-10-07T00:00:00.000Z';

async function openRow(
  stores: MemoryStores,
  origin: 'self' | 'human' = 'self',
): Promise<Commitment> {
  await stores.commitments.open({ id: 'c1', at: AT, origin, body: '直す前の本文' });
  const row = await stores.commitments.get('c1');
  if (row === null) throw new Error('行が開けていない');
  return row;
}

const entry: JournalEntryInput = {
  type: 'decision',
  decision: '引き受けた仕事の本文を直した（c1）: 編集前「直す前の本文」→ 編集後「直した後の本文」',
  grounds: 'テスト',
};

function failingJournal(stores: MemoryStores): MemoryStores {
  return {
    ...stores,
    journal: {
      ...stores.journal,
      async append(): Promise<never> {
        throw new Error('journal down');
      },
    },
  } as unknown as MemoryStores;
}

// 先の行を書いた後、`editBody` の直前に割り込みを差し込む。`seen` には、その瞬間に日誌に在った決定の行数を積む
function interruptEdit(
  stores: MemoryStores,
  interrupt: () => Promise<void>,
  seen: number[] = [],
): MemoryStores {
  return {
    ...stores,
    commitments: {
      ...stores.commitments,
      async editBody(...args: Parameters<MemoryStores['commitments']['editBody']>) {
        seen.push((await stores.journal.list({ types: ['decision'] })).length);
        await interrupt();
        return stores.commitments.editBody(...args);
      },
    },
  } as unknown as MemoryStores;
}

describe('editCommitmentBodyJournalFirst（#5242）', () => {
  it('書き直す瞬間には、編集前後の本文を持つ先の行が日誌に既に在る', async () => {
    const stores = createMemoryStores();
    const existing = await openRow(stores);
    const seen: number[] = [];
    const spied = interruptEdit(stores, async () => undefined, seen);

    const result = await editCommitmentBodyJournalFirst(
      spied,
      existing,
      '直した後の本文',
      'clone',
      entry,
    );

    expect(result.kind).toBe('edited');
    expect(seen).toEqual([1]);
    expect((await stores.commitments.get('c1'))?.body).toBe('直した後の本文');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('編集前「直す前の本文」→ 編集後「直した後の本文」');
  });

  it('日誌に書けなければ journal-failed を返し、行の本文は元のまま', async () => {
    const stores = createMemoryStores();
    const existing = await openRow(stores);
    const result = await editCommitmentBodyJournalFirst(
      failingJournal(stores),
      existing,
      '直した後の本文',
      'clone',
      entry,
    );
    expect(result.kind).toBe('journal-failed');
    const row = await stores.commitments.get('c1');
    expect(row?.body).toBe('直す前の本文');
    expect(row?.editedAt).toBeUndefined();
  });

  it('読んだ行が既に閉じていれば、日誌を書かず not-edited を返す', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    await stores.commitments.close('c1', '2026-10-07T01:00:00.000Z', '閉じた', 'clone');
    const closed = (await stores.commitments.get('c1')) as Commitment;
    const result = await editCommitmentBodyJournalFirst(stores, closed, 'x', 'clone', entry);
    expect(result.kind).toBe('not-edited');
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
  });

  it('ifMatch が読んだ版と既に合わなければ、日誌を書かず conflict を返す', async () => {
    const stores = createMemoryStores();
    const existing = await openRow(stores);
    const result = await editCommitmentBodyJournalFirst(stores, existing, 'x', 'human', entry, {
      ifMatch: '2000-01-01T00:00:00.000Z',
    });
    expect(result.kind).toBe('conflict');
    expect(await stores.journal.list({ types: ['decision'] })).toEqual([]);
    expect((await stores.commitments.get('c1'))?.body).toBe('直す前の本文');
  });

  it('日誌を書いた後に閉じられたら、打ち消しの行を足して not-edited を返す', async () => {
    const stores = createMemoryStores();
    const existing = await openRow(stores);
    const raced = interruptEdit(stores, async () => {
      await stores.commitments.close('c1', '2026-10-07T01:00:00.000Z', '閉じた', 'human');
    });

    const result = await editCommitmentBodyJournalFirst(raced, existing, 'x', 'clone', entry);

    expect(result.kind).toBe('not-edited');
    expect((await stores.commitments.get('c1'))?.body).toBe('直す前の本文');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('直前の本文編集の行は効いていない（本文は直していない）');
  });

  it('日誌を書いた後に版が変わったら、打ち消しの行を足して conflict を返す', async () => {
    const stores = createMemoryStores();
    const existing = await openRow(stores, 'human');
    const raced = interruptEdit(stores, async () => {
      await stores.commitments.editBody('c1', '別の書き手', '2026-10-07T00:30:00.000Z', 'human');
    });

    const result = await editCommitmentBodyJournalFirst(raced, existing, 'x', 'human', entry, {
      ifMatch: AT,
    });

    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') expect(result.error).toBeInstanceOf(CommitmentConflictError);
    expect((await stores.commitments.get('c1'))?.body).toBe('別の書き手');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('直前の本文編集の行は効いていない（本文は直していない）');
  });

  it('editBody が例外で落ちたら、打ち消しの行を足して投げ直す', async () => {
    const stores = createMemoryStores();
    const existing = await openRow(stores);
    const broken = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async editBody(): Promise<never> {
          throw new Error('store down');
        },
      },
    } as unknown as MemoryStores;
    await expect(
      editCommitmentBodyJournalFirst(broken, existing, 'x', 'clone', entry),
    ).rejects.toThrow('store down');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('直前の本文編集の行は効いていない（本文は直していない）');
  });
});

describe('commitment_edit は日誌を先に書く（#5242）', () => {
  function tools(stores: MemoryStores) {
    const list = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
      managers: {} as unknown as ManagerPool,
    });
    const found = list.find((tool) => tool.name === 'commitment_edit');
    if (!found) throw new Error('commitment_edit が無い');
    return found;
  }

  it('日誌に書けないときは書き直さず、行為が起きていないと投げる', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    await expect(
      tools(failingJournal(stores)).handler({ id: 'c1', body: '直した後の本文' } as never, {}),
    ).rejects.toThrow('行為は起きていない');
    expect((await stores.commitments.get('c1'))?.body).toBe('直す前の本文');
  });

  it('書き直す瞬間に、編集前後の本文を持つ先の行が日誌に在る', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    const seen: string[] = [];
    const spied = {
      ...stores,
      commitments: {
        ...stores.commitments,
        async editBody(...args: Parameters<MemoryStores['commitments']['editBody']>) {
          seen.push(JSON.stringify(await stores.journal.list({ types: ['decision'] })));
          return stores.commitments.editBody(...args);
        },
      },
    } as unknown as MemoryStores;

    const result = await tools(spied).handler({ id: 'c1', body: '直した後の本文' } as never, {});

    expect(JSON.stringify(result)).toContain('直した');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('編集前「直す前の本文」→ 編集後「直した後の本文」');
  });

  it('日誌を書いた後に閉じられたら、打ち消しの行を足し、片付いていると言う', async () => {
    const stores = createMemoryStores();
    await openRow(stores);
    const raced = interruptEdit(stores, async () => {
      await stores.commitments.close('c1', '2026-10-07T01:00:00.000Z', '閉じた', 'human');
    });

    const result = await tools(raced).handler({ id: 'c1', body: '直した後の本文' } as never, {});

    expect(JSON.stringify(result)).toContain('既に');
    expect((await stores.commitments.get('c1'))?.body).toBe('直す前の本文');
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('直前の本文編集の行は効いていない（本文は直していない）');
  });
});
