import type { JournalStore } from './store.js';

// vitest の `expect` で書かない: `storage-fs` / `storage-pg` が `@alteroid/core` を実行時の依存として読むため
export type JournalStoreHorizonContractSubject = Pick<JournalStore, 'append' | 'oldestAt'>;

export async function verifyJournalStoreHorizonContract(
  journal: JournalStoreHorizonContractSubject,
): Promise<void> {
  const empty = await journal.oldestAt();
  if (empty !== null) {
    throw new Error(
      'JournalStore の日誌の地平の契約（1: 空なら null）が破れている — ' +
        `何も追記していないのに oldestAt() が ${JSON.stringify(empty)} を返した。` +
        'この契約を測るには、まっさらな（何も追記していない）ストアを渡すこと。',
    );
  }

  const first = await journal.append({
    type: 'decision',
    decision: 'journal-horizon-contract: first（最古）',
    grounds: 'journal-horizon-contract',
  });
  const afterOne = await journal.oldestAt();
  if (afterOne !== first.at) {
    throw new Error(
      'JournalStore の日誌の地平の契約（2: 1件なら its at）が破れている — ' +
        `期待 ${JSON.stringify(first.at)}、実際 ${JSON.stringify(afterOne)}。`,
    );
  }

  // 待ちを挟んで `at` をずらさない: 比べているのは値であって行の同一性ではなく、同じ `at` でも期待値は同じ文字列になるため
  await journal.append({
    type: 'decision',
    decision: 'journal-horizon-contract: second（新しい）',
    grounds: 'journal-horizon-contract',
  });
  await journal.append({
    type: 'decision',
    decision: 'journal-horizon-contract: third（さらに新しい）',
    grounds: 'journal-horizon-contract',
  });
  const afterThree = await journal.oldestAt();
  if (afterThree !== first.at) {
    throw new Error(
      'JournalStore の日誌の地平の契約（3: 複数件でも最古のまま）が破れている — ' +
        `最初に追記した行の at（${JSON.stringify(first.at)}）を返すはずが、` +
        `実際は ${JSON.stringify(afterThree)} だった（新しい行に引きずられていないか確認すること）。`,
    );
  }
}
