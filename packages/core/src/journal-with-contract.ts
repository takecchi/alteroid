import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg は `@alteroid/core` を実行時の依存として読むので、`expect` で書くとその依存を2パッケージへ持ち込む。
export type JournalStoreWithContractSubject = Pick<JournalStore, 'append' | 'list'>;

export async function verifyJournalStoreWithContract(
  journal: JournalStoreWithContractSubject,
): Promise<void> {
  // human を先に積み、その後に manager を複数積む: new→old で返るストアで with を limit の後ろで絞ると、human は既に切り落とされている（契約4の要）。
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

  const empty = await journal.list({ with: [] });
  if (empty.length !== 0) {
    throw new Error(
      `JournalStore の with 契約（3: []=0件）が破れている — with: [] は ${empty.length} 件返した。`,
    );
  }

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
