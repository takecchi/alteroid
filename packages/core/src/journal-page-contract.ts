import type { JournalStore } from './store.js';

/**
 * `JournalStore.listPage()`（続きの有無と次の頁の継続点。Issue #2604 / #2605）の
 * 契約を、実装1つに対して測る。インメモリ・fs・pg で同じ関数を呼ぶ。
 *
 * 測るもの（`types: ['decision']` で絞る——他の契約が同じストアへ書いた行があっても
 * 動くよう、総数は自分で数える）:
 *
 * 1. `entries` は同じ問い合わせの `list()` と同じ
 * 2. `limit` が総数ちょうど・それ以上なら `next === null`（本当の終端）。
 *    総数より1つ少なければ `next !== null`
 * 3. `limit` 未指定・`0` は `next === null`
 * 4. `next` を `after` に渡して読み継ぐと、全件を重複も欠落も無く、`desc` でも
 *    `asc` でも `list()` の全件と同じ順で読める。最後の頁だけが `next === null`
 *
 * **読めない行を含む頁は、ここでは作れない**（`append` は形を検査して拒む）。
 * その形は、pg 実装の実ストアの歯と、`listPage` を持つ偽ストアの歯が測る。
 *
 * 使い捨てのストアを渡すこと（行が残る）。
 */
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

  // --- 契約1・2: entries は list() と同じ。next は「本当に先が在るか」 ---
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

  // --- 契約3: limit 未指定・0 は続きを言わない ---
  const unbounded = await journal.listPage({ types: ['decision'] });
  if (unbounded.next !== null || unbounded.entries.length !== total) {
    throw new Error('journal-page-contract: limit 未指定の listPage は全件を返し next=null のはず');
  }
  const zero = await journal.listPage({ types: ['decision'], limit: 0 });
  if (zero.next !== null || zero.entries.length !== 0) {
    throw new Error('journal-page-contract: limit: 0 は0件・next=null のはず');
  }

  // --- 契約4: next で読み継ぐと全件を過不足なく読める（desc / asc） ---
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
