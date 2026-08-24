import type { JournalStore } from './store.js';

/**
 * `JournalStore` の `with` 絞りの契約を、実装1つに対して測る（issue #418）。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか。** `packages/storage-fs`
 * と `packages/storage-pg` は `@alteroid/core` を実行時の依存として読む
 * （`dist/index.js` 経由）。契約を vitest の `expect` で書くと、その依存を
 * 2パッケージへ持ち込むことになる（`persona-contract.test.ts` の doc と同じ
 * 理由）。ここは食い違ったら `throw` する素の関数にして、呼ぶ側（各パッケージの
 * テストファイル）が好きな assertion 道具でラップできるようにしてある。
 *
 * **測る4性質。3実装（`packages/core/src/testing.ts` のインメモリ /
 * `packages/storage-fs/src/journal.ts` / `packages/storage-pg/src/journal.ts`）
 * すべてがこれを呼ぶこと。呼んでいない実装が増えたら
 * `scripts/journal-store-with-contract-registry.test.ts` が落ちる。**
 *
 * 1. **`with` 未指定 = 絞らない**（既存の挙動を1文字も変えない）
 * 2. **`with` を指定 = その値の `exchange` だけを返す。** `exchange` を持たない
 *    種別（`decision` 等）は `with` を持たないので、`types` を明示しなくても
 *    絞りに掛からない
 * 3. **`with: []` = 0件**
 * 4. **`with` は `limit` より前に効く。** #418 の穴の本体そのもの — ここが
 *    崩れていると、`with` を指定しても `scan`（`limit`）の予算を無関係な
 *    `with` の行が食い尽くし、狙った行が窓の外へ落ちる
 *
 * `append` した行は呼び出し側のストアへ実際に残る（後始末はしない）。
 * 使い捨てのストアを渡すこと（各テストファイルは毎回新しいストアを作っている）。
 */
export type JournalStoreWithContractSubject = Pick<JournalStore, 'append' | 'list'>;

export async function verifyJournalStoreWithContract(
  journal: JournalStoreWithContractSubject,
): Promise<void> {
  // **積む順序が契約4（limit より前に効く）の要である。** human を先に積み、
  // その後に manager を複数積むと、new→old で返るストアでは manager のほうが
  // 「新しい」= limit:1 の候補に先に入る。with を limit の後ろで絞る実装だと、
  // その1件（manager）が候補になった時点で human は既に切り落とされている。
  const human = await journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: 'journal-with-contract: human',
  });
  await journal.append({
    type: 'decision',
    decision: 'journal-with-contract: decision（with を持たない種別）',
    grounds: 'journal-with-contract',
  });
  const managerCount = 5;
  for (let i = 0; i < managerCount; i += 1) {
    await journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: `journal-with-contract: manager-${i}`,
    });
  }

  // --- 契約1: 未指定 = 絞らない ---
  const unfiltered = await journal.list({ types: ['exchange'] });
  const unfilteredWiths = new Set(
    unfiltered.flatMap((entry) => (entry.type === 'exchange' ? [entry.with] : [])),
  );
  if (!unfilteredWiths.has('human') || !unfilteredWiths.has('manager')) {
    throw new Error(
      'JournalStore の with 契約（1: 未指定=絞らない）が破れている — ' +
        `with 未指定で human/manager の両方が返るはずが、実際に見えた with は ` +
        `${JSON.stringify([...unfilteredWiths])} だった。`,
    );
  }

  // --- 契約2: 指定 = その with だけ（非 exchange は types を明示しなくても返らない） ---
  const humanOnly = await journal.list({ with: ['human'] });
  const wrongKind = humanOnly.find((entry) => entry.type !== 'exchange' || entry.with !== 'human');
  if (wrongKind !== undefined) {
    throw new Error(
      'JournalStore の with 契約（2: 指定=その with だけ）が破れている — ' +
        `with: ['human'] が exchange 以外、または with が一致しない行を返した: ` +
        `${JSON.stringify(wrongKind)}`,
    );
  }
  if (!humanOnly.some((entry) => entry.id === human.id)) {
    throw new Error(
      'JournalStore の with 契約（2: 指定=その with だけ）が破れている — ' +
        `with: ['human'] が、積んだ human の行（id=${human.id}）を返さなかった。`,
    );
  }

  // --- 契約3: [] = 0件 ---
  const empty = await journal.list({ with: [] });
  if (empty.length !== 0) {
    throw new Error(
      `JournalStore の with 契約（3: []=0件）が破れている — with: [] は ${empty.length} 件返した。`,
    );
  }

  // --- 契約4: limit より前に効く（#418 の穴の本体） ---
  const windowed = await journal.list({ limit: 1, types: ['exchange'], with: ['human'] });
  if (windowed.length !== 1 || windowed[0]?.id !== human.id) {
    throw new Error(
      'JournalStore の with 契約（4: limit より前に効く。#418）が破れている — ' +
        `human の行の前に manager を${managerCount}件積んだ状態で ` +
        `list({ limit: 1, types: ['exchange'], with: ['human'] }) を呼んだが、` +
        `human の行（id=${human.id}）が1件返らなかった（実際に返った件数: ` +
        `${windowed.length}）。with の絞りが limit の後ろで効いている疑いがある。`,
    );
  }
}
