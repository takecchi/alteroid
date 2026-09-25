import type { JournalStore } from './store.js';

/**
 * `JournalStore.oldestAt()`（日誌の地平。issue #1510）の契約を、実装1つに
 * 対して測る。
 *
 * **なぜ在るか。** `journal_read`（`tools.ts`）が `since`/`until` で過去を
 * 掘って0件が返ったとき、「その窓に該当が無かった」のか「日誌がその窓まで
 * 遡れない（分母が0）」のかを見分けるために `oldestAt()` を新設した
 * （store.ts の `JournalStore.oldestAt` の doc）。3実装（インメモリ / fs /
 * pg）が同じ答えを返すことを、ここで1本にして測る。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか。** 他の
 * `journal-*-contract.ts` と同じ理由（`journal-with-contract.ts` の doc）
 * ——`packages/storage-fs` と `packages/storage-pg` は `@alteroid/core` を
 * 実行時の依存として読むので、ここを vitest の `expect` で書くとその依存を
 * 2パッケージへ持ち込むことになる。
 *
 * **測る3性質。3実装すべてがこれを呼ぶこと。呼んでいない実装が増えたら
 * `scripts/journal-store-with-contract-registry.test.ts` が落ちる。**
 *
 * 1. **1件も無ければ `null`**
 * 2. **1件だけなら、その行の `at`**
 * 3. **複数件のときは、追記順で最初（＝最古）の行の `at`。あとから追記した
 *    新しい行に引きずられない** —— `list()` の既定（新しい順）と逆側を
 *    見ていることの検算でもある
 *
 * `append` した行は呼び出し側のストアへ実際に残る（後始末はしない）。
 * 使い捨てのストアを渡すこと（各テストファイルは毎回新しいストアを作っている）。
 * **1つ目の契約（空 = null）を測るため、渡すストアは何も追記していない
 * まっさらな状態であること** —— この関数は呼び出しの最初に `oldestAt()` を
 * 呼んで空であることを確かめる。
 */
export type JournalStoreHorizonContractSubject = Pick<JournalStore, 'append' | 'oldestAt'>;

export async function verifyJournalStoreHorizonContract(
  journal: JournalStoreHorizonContractSubject,
): Promise<void> {
  // --- 契約1: 1件も無ければ null ---
  const empty = await journal.oldestAt();
  if (empty !== null) {
    throw new Error(
      'JournalStore の日誌の地平の契約（1: 空なら null）が破れている — ' +
        `何も追記していないのに oldestAt() が ${JSON.stringify(empty)} を返した。` +
        'この契約を測るには、まっさらな（何も追記していない）ストアを渡すこと。',
    );
  }

  // --- 契約2: 1件だけならその行の at ---
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

  // --- 契約3: 複数件でも最古（=最初に追記した行）の at のまま ---
  // **同じミリ秒に積まれても壊れない。** `at` はミリ秒精度だが、比較している
  // のは値（文字列）であって行の同一性ではないので、first と後続の行が
  // たまたま同じ `at` を持っても、期待値と実際値はどのみち同じ文字列になる
  // ——待ちを挟んでずらす必要は無い。
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
