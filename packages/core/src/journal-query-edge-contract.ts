import type { JournalStore } from './store.js';
import { JournalAnchorNotFoundError } from './store.js';

// vitest の `expect` で書かない: `storage-fs` / `storage-pg` が `@alteroid/core` を実行時の依存として読むため
// 退化した値を「絞らない」へ倒さない: 呼ぶ側が絞ったつもりの問い合わせに全件が返り、黙って広がる側に壊れるため
export type JournalStoreQueryEdgeContractSubject = Pick<JournalStore, 'append' | 'list' | 'get'>;

export async function verifyJournalStoreQueryEdgeContract(
  journal: JournalStoreQueryEdgeContractSubject,
): Promise<void> {
  const decisionA = await journal.append({
    type: 'decision',
    decision: 'journal-query-edge-contract: decision-a',
    grounds: 'journal-query-edge-contract',
  });
  const decisionB = await journal.append({
    type: 'decision',
    decision: 'journal-query-edge-contract: decision-b',
    grounds: 'journal-query-edge-contract',
  });
  await journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: 'journal-query-edge-contract: exchange',
  });

  const emptyTypes = await journal.list({ types: [] });
  if (emptyTypes.length !== 0) {
    throw new Error(
      'JournalStore の query edge 契約（1: types: []=0件）が破れている — ' +
        `types: [] は ${emptyTypes.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(emptyTypes.map((entry) => entry.id))}）。`,
    );
  }

  const zeroLimit = await journal.list({ limit: 0 });
  if (zeroLimit.length !== 0) {
    throw new Error(
      'JournalStore の query edge 契約（2: limit: 0=0件）が破れている — ' +
        `limit: 0 は ${zeroLimit.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(zeroLimit.map((entry) => entry.id))}）。`,
    );
  }

  const unfiltered = await journal.list({});
  const hasDecision = unfiltered.some((entry) => entry.id === decisionA.id);
  const hasExchange = unfiltered.some((entry) => entry.type === 'exchange');
  if (!hasDecision || !hasExchange) {
    throw new Error(
      'JournalStore の query edge 契約（3: types 未指定=絞らない）が破れている — ' +
        'types 未指定で decision と exchange の両方が返るはずが、' +
        `実際に返った types は ${JSON.stringify([...new Set(unfiltered.map((entry) => entry.type))])} だった。`,
    );
  }

  const decisionsOnly = await journal.list({ types: ['decision'] });
  const wrongType = decisionsOnly.find((entry) => entry.type !== 'decision');
  if (wrongType !== undefined) {
    throw new Error(
      'JournalStore の query edge 契約（4: types 指定=その種別だけ）が破れている — ' +
        `types: ['decision'] が decision 以外の行を返した: ${JSON.stringify(wrongType)}`,
    );
  }
  if (
    !decisionsOnly.some((entry) => entry.id === decisionA.id) ||
    !decisionsOnly.some((entry) => entry.id === decisionB.id)
  ) {
    throw new Error(
      'JournalStore の query edge 契約（4: types 指定=その種別だけ）が破れている — ' +
        `types: ['decision'] が積んだ decision の両方（${decisionA.id}, ${decisionB.id}）を` +
        `返さなかった（実際: ${JSON.stringify(decisionsOnly.map((entry) => entry.id))}）。`,
    );
  }

  const limitedTwo = await journal.list({ limit: 2 });
  if (limitedTwo.length !== 2) {
    throw new Error(
      'JournalStore の query edge 契約（5: limit:N(N>=1)はN件で切る）が破れている — ' +
        `limit: 2 は ${limitedTwo.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(limitedTwo.map((entry) => entry.id))}）。`,
    );
  }

  const bothEmpty = await journal.list({ types: [], with: [] });
  if (bothEmpty.length !== 0) {
    throw new Error(
      'JournalStore の query edge 契約（6: types:[]とwith:[]の同時指定=0件）が破れている — ' +
        `types: [] と with: [] を同時に渡すと ${bothEmpty.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(bothEmpty.map((entry) => entry.id))}）。`,
    );
  }

  {
    const fail = (label: string, detail: unknown): never => {
      throw new Error(
        `JournalStore の NUL の契約（7: ${label}）が破れている — ${JSON.stringify(detail)}`,
      );
    };
    const nulAppended = await journal.append({
      type: 'decision',
      decision: 'journal-nul: dec\u0000ision',
      grounds: 'journal-nul: gro\u0000unds',
    });
    if (nulAppended.type !== 'decision' || nulAppended.decision !== 'journal-nul: decision') {
      fail('appendの返り値の本文の NUL を落とす', nulAppended);
    }
    const nulRead = await journal.get(nulAppended.id);
    if (
      nulRead?.type !== 'decision' ||
      nulRead.decision !== 'journal-nul: decision' ||
      nulRead.grounds !== 'journal-nul: grounds'
    ) {
      fail('読み戻しの本文の NUL を落として残す', nulRead);
    }

    const nulId = `${nulAppended.id}\u0000`;
    const countBefore = (await journal.list()).length;
    const queries: Array<[string, () => Promise<unknown>, unknown]> = [
      ['get(NULを含むid)はnull', () => journal.get(nulId), null],
      [
        'q に NUL を含む値は0件',
        async () => (await journal.list({ q: 'journal-query-edge-contract\u0000' })).length,
        0,
      ],
    ];
    for (const [label, call, expected] of queries) {
      let outcome: unknown;
      try {
        outcome = await call();
      } catch (error) {
        fail(label, { 投げた: error instanceof Error ? error.name : typeof error });
      }
      if (outcome !== expected) fail(label, { 実際: outcome });
    }
    let anchorThrown: unknown;
    try {
      await journal.list({ after: { id: nulId, at: nulAppended.at } });
    } catch (error) {
      anchorThrown = error;
    }
    if (!(anchorThrown instanceof JournalAnchorNotFoundError)) {
      fail('after.id に NUL を含む錨は JournalAnchorNotFoundError', {
        実際: anchorThrown === undefined ? '投げなかった' : String(anchorThrown),
      });
    }
    if ((await journal.list()).length !== countBefore) fail('読んだだけなのに行が変わった', null);
  }
}
