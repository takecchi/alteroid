import type { JournalStore } from './store.js';
import { JournalAnchorNotFoundError } from './store.js';

/**
 * `JournalStore` の `types` / `limit` に渡す**退化した値**（空配列・`0`）の
 * 契約を、実装1つに対して測る（issue #425）。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか。** `journal-with-contract.ts`
 * の doc と同じ理由 —— `packages/storage-fs` と `packages/storage-pg` は
 * `@alteroid/core` を実行時の依存として読む（`dist/index.js` 経由）ので、
 * ここを vitest の `expect` で書くとその依存を2パッケージへ持ち込むことになる。
 * 食い違ったら `throw` する素の関数にして、呼ぶ側（各パッケージのテスト
 * ファイル）が好きな assertion 道具でラップできるようにしてある。
 *
 * **なぜ「0件」へ揃えたか。** 退化した値（空配列・`0`）は「指定しなかった」
 * ではなく「どれにも当たらない／0件くれ」である。「絞らない」へ倒すと、
 * 呼ぶ側が絞ったつもりの問い合わせに全件が返る —— これは黙って広がる側の
 * 壊れ方で、`AGENTS.md`「判定できないという3つ目の状態を持つ」が避けている
 * 形と同じである。`with: []` は #418 で既に0件に決まっている（`store.ts` の
 * `JournalQuery.with` の doc）ので、`types` と `limit` もそこへ揃えた。
 *
 * `types` の食い違いの実体は、3実装のうち pg だけが `query.types.length === 0`
 * を特別扱いして「絞らない」に倒していたことである（`with` の行はそういう
 * 特別扱いを持っていない。`packages/storage-pg/src/journal.ts` の `types` /
 * `with` の行を参照）。`limit` の食い違いの実体は、fs だけが「push してから
 * 件数を判定する」形になっていて `limit: 0` でも1件 push してしまうことで
 * ある（`packages/storage-fs/src/journal.ts` の `found.push(entry)` の直後の
 * 判定を参照）。
 *
 * **測る6性質。3実装（`packages/core/src/testing.ts` のインメモリ /
 * `packages/storage-fs/src/journal.ts` / `packages/storage-pg/src/journal.ts`）
 * すべてがこれを呼ぶこと。呼んでいない実装が増えたら
 * `scripts/journal-store-with-contract-registry.test.ts` が落ちる。**
 *
 * 1. **`types: []` = 0件**（「どれにも当たらない」という指定）
 * 2. **`limit: 0` = 0件**（「0件くれ」という指定）
 * 3. **`types` 未指定 = 絞らない**（既存の挙動を1文字も変えない）
 * 4. **`types: ['decision']` = その種別だけを返す**
 * 5. **`limit: N`（`N >= 1`）は N 件で切る** —— これを測るのは、`limit: 0`
 *    の直しが `limit >= 1` の挙動を巻き込んでいないことを確かめるためで
 *    ある（fs の off-by-one を逆向きに直しすぎていないか）
 * 6. **`types: []` と `with: []` を同時に渡しても0件**（互いに打ち消し
 *    合わない —— 片方だけ見て「絞りが無い」と早合点する実装だと、もう
 *    片方の空配列を無視して全件を返しかねない）
 *
 * `append` した行は呼び出し側のストアへ実際に残る（後始末はしない）。
 * 使い捨てのストアを渡すこと（各テストファイルは毎回新しいストアを作っている）。
 */
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

  // --- 契約1: types: [] = 0件 ---
  const emptyTypes = await journal.list({ types: [] });
  if (emptyTypes.length !== 0) {
    throw new Error(
      'JournalStore の query edge 契約（1: types: []=0件）が破れている — ' +
        `types: [] は ${emptyTypes.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(emptyTypes.map((entry) => entry.id))}）。`,
    );
  }

  // --- 契約2: limit: 0 = 0件 ---
  const zeroLimit = await journal.list({ limit: 0 });
  if (zeroLimit.length !== 0) {
    throw new Error(
      'JournalStore の query edge 契約（2: limit: 0=0件）が破れている — ' +
        `limit: 0 は ${zeroLimit.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(zeroLimit.map((entry) => entry.id))}）。`,
    );
  }

  // --- 契約3: types 未指定 = 絞らない ---
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

  // --- 契約4: types: ['decision'] = その種別だけ ---
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

  // --- 契約5: limit: N（N>=1）は N 件で切る ---
  // limit: 0 の直しが limit >= 1 を巻き込んでいないかを測るための性質。
  // decisionA/decisionB に加えて exchange 1件、計3件が積んである状態で
  // limit: 2 を掛けると、ちょうど2件（新しい順の先頭2件）が返るはず。
  const limitedTwo = await journal.list({ limit: 2 });
  if (limitedTwo.length !== 2) {
    throw new Error(
      'JournalStore の query edge 契約（5: limit:N(N>=1)はN件で切る）が破れている — ' +
        `limit: 2 は ${limitedTwo.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(limitedTwo.map((entry) => entry.id))}）。`,
    );
  }

  // --- 契約6: types: [] と with: [] を同時に渡しても0件（互いに打ち消さない） ---
  const bothEmpty = await journal.list({ types: [], with: [] });
  if (bothEmpty.length !== 0) {
    throw new Error(
      'JournalStore の query edge 契約（6: types:[]とwith:[]の同時指定=0件）が破れている — ' +
        `types: [] と with: [] を同時に渡すと ${bothEmpty.length} 件返した（実際に返った行: ` +
        `${JSON.stringify(bothEmpty.map((entry) => entry.id))}）。`,
    );
  }

  // --- 契約7: NUL（issue #3011。teto の判断、2026-10-06） ---
  // 書き込み: 日誌は id を store が振るので断る鍵が無い。本文の NUL は落として残す（記録を失わない）。
  // 読むだけの口: id・全文検索 q に NUL があっても断らず、「無い」と同じ結果（get は null、q は0件、
  // 錨は見つからない）を返す。投げない。
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
