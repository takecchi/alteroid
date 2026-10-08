import type { JournalStore } from './store.js';

export type JournalStorePageContractSubject = Pick<JournalStore, 'append' | 'list' | 'listPage'>;

export async function verifyJournalStorePageContract(
  journal: JournalStorePageContractSubject,
): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await journal.append({
      type: 'decision',
      decision: `journal-page-contract: decision-${i}`,
      grounds: 'journal-page-contract',
    });
  }
  const all = await journal.list({ types: ['decision'] });
  const total = all.length;
  if (total < 5) throw new Error(`journal-page-contract: 追記した5件が読めない（${total}件）`);

  for (const limit of [1, 2, total - 1, total, total + 1]) {
    const page = await journal.listPage({ types: ['decision'], limit });
    const expected = all.slice(0, limit);
    if (JSON.stringify(page.entries) !== JSON.stringify(expected)) {
      throw new Error(`journal-page-contract: limit=${limit} の entries が list() と違う`);
    }
    const hasMore = total > limit;
    if (hasMore !== (page.next !== null)) {
      throw new Error(
        `journal-page-contract: limit=${limit}（総数 ${total}）で next=${JSON.stringify(page.next)}。` +
          `続きは${hasMore ? '在る' : '無い'}はず`,
      );
    }
    const last = expected[expected.length - 1];
    if (page.next !== null && (last?.id !== page.next.id || last.at !== page.next.at)) {
      throw new Error(
        `journal-page-contract: limit=${limit} の next が返した最後の行を指さない` +
          '（読めない行が無いストアでは、継続点は最後の行のはず）',
      );
    }
  }

  const unbounded = await journal.listPage({ types: ['decision'] });
  if (unbounded.next !== null || unbounded.entries.length !== total) {
    throw new Error('journal-page-contract: limit 未指定の listPage は全件を返し next=null のはず');
  }
  const zero = await journal.listPage({ types: ['decision'], limit: 0 });
  if (zero.next !== null || zero.entries.length !== 0) {
    throw new Error('journal-page-contract: limit: 0 は0件・next=null のはず');
  }

  for (const order of ['desc', 'asc'] as const) {
    const expectedIds = (await journal.list({ types: ['decision'], order })).map((e) => e.id);
    const seen: string[] = [];
    let after: { id: string; at: string } | undefined;
    for (let guard = 0; guard < total + 2; guard += 1) {
      const page = await journal.listPage({
        types: ['decision'],
        order,
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
      seen.push(...page.entries.map((e) => e.id));
      if (page.next === null) break;
      after = page.next;
    }
    if (JSON.stringify(seen) !== JSON.stringify(expectedIds)) {
      throw new Error(`journal-page-contract: order=${order} で next を辿った結果が全件と違う`);
    }
  }
}
