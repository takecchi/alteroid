import type { JournalEntry } from './schema.js';
import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg は `@alteroid/core` を実行時の依存として読むので、`expect` で書くとその依存を2パッケージへ持ち込む。
export type JournalStoreConversationIdContractSubject = Pick<
  JournalStore,
  'append' | 'list' | 'listPage'
>;

const MARKER = 'journal-conversation-id-contract';

function fail(property: string, detail: string): never {
  throw new Error(`JournalStore の conversationId 契約（${property}）が破れている — ${detail}`);
}

function ids(entries: readonly JournalEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

function expectIds(property: string, label: string, actual: JournalEntry[], expected: string[]) {
  if (JSON.stringify(ids(actual)) !== JSON.stringify(expected)) {
    fail(
      property,
      `${label} が ${JSON.stringify(expected)} を返すはずが ${JSON.stringify(ids(actual))} だった。`,
    );
  }
}

/**
 * `JournalQuery.conversationId` の契約を、実装1つに対して測る。3実装（インメモリ / `storage-fs` / `storage-pg`）すべてがこれを呼ぶこと。
 *
 * 1. 指定 = その会話の行だけ（別の会話・`conversationId` の無い行は返らない）。存在しない id は0件
 * 2. `limit` より前に効く: 対象の会話より新しい側に別の会話の行を積んでも、`limit: 1` で対象の会話の行が返る
 * 3. `with` と併用できる
 * 4. `after` と併用できる（錨は絞り込み前の全順序で決める。錨が絞りに当たらない行でもよい）。`listPage` の `next` も同じ
 * 5. 墓標のある会話の行は、`conversationId` で名指しされても今までどおり外れる
 * 6. `''` は「絞らない」へ倒さない（値として一致する行だけ。空の id の行は積まないので0件）
 */
export async function verifyJournalStoreConversationIdContract(
  journal: JournalStoreConversationIdContractSubject,
): Promise<void> {
  const target = `${MARKER}-target`;
  const other = `${MARKER}-other`;
  const doomed = `${MARKER}-doomed`;

  const exchange = (
    text: string,
    conversationId: string | undefined,
    withWho: 'human' | 'manager' = 'human',
  ) =>
    journal.append({
      type: 'exchange',
      with: withWho,
      role: 'inbound',
      text: `${MARKER}: ${text}`,
      ...(conversationId === undefined ? {} : { conversationId }),
    });

  // 対象の会話を古い側に置き、別の会話を新しい側へ積む: limit の後ろで絞るストアは、対象の会話が窓から落ちる。
  const targetHuman = await exchange('target-human', target);
  const targetManager = await exchange('target-manager', target, 'manager');
  await exchange('no-conversation', undefined);
  const otherRows: JournalEntry[] = [];
  for (let i = 0; i < 5; i += 1) {
    otherRows.push(await exchange(`other-${i}`, other));
  }
  const newestOther = otherRows[otherRows.length - 1];
  if (newestOther === undefined) throw new Error('unreachable');

  // --- 契約1 ---
  expectIds(
    '1: その会話の行だけ',
    `list({ conversationId })`,
    await journal.list({ conversationId: target }),
    [targetManager.id, targetHuman.id],
  );
  expectIds(
    '1: その会話の行だけ',
    `list({ conversationId: 存在しない id })`,
    await journal.list({ conversationId: `${MARKER}-nonexistent` }),
    [],
  );

  // --- 契約2 ---
  expectIds(
    '2: limit より前に効く',
    `別の会話の行を新しい側に ${otherRows.length} 件積んだ状態の list({ conversationId, limit: 1 })`,
    await journal.list({ conversationId: target, limit: 1 }),
    [targetManager.id],
  );
  expectIds(
    '2: limit より前に効く',
    `list({ conversationId, with: ['human'], types: ['exchange'], limit: 1 })`,
    await journal.list({
      conversationId: target,
      with: ['human'],
      types: ['exchange'],
      limit: 1,
    }),
    [targetHuman.id],
  );

  // --- 契約3 ---
  expectIds(
    '3: with と併用できる',
    `list({ conversationId, with: ['manager'] })`,
    await journal.list({ conversationId: target, with: ['manager'] }),
    [targetManager.id],
  );
  expectIds(
    '3: with と併用できる',
    `list({ conversationId: other, with: ['manager'] })`,
    await journal.list({ conversationId: other, with: ['manager'] }),
    [],
  );

  // --- 契約4 ---
  expectIds(
    '4: after と併用できる',
    `list({ conversationId, after: <対象の会話の最新行> })`,
    await journal.list({
      conversationId: target,
      after: { id: targetManager.id, at: targetManager.at },
    }),
    [targetHuman.id],
  );
  expectIds(
    '4: after と併用できる',
    `list({ conversationId, after: <別の会話の最新行> })（錨は絞り込み前の全順序で決める）`,
    await journal.list({
      conversationId: target,
      after: { id: newestOther.id, at: newestOther.at },
    }),
    [targetManager.id, targetHuman.id],
  );
  const pageOne = await journal.listPage({ conversationId: target, limit: 1 });
  expectIds('4: after と併用できる', `listPage({ conversationId, limit: 1 })`, pageOne.entries, [
    targetManager.id,
  ]);
  if (pageOne.next === null) {
    fail(
      '4: after と併用できる',
      'listPage({ conversationId, limit: 1 }) の next が null だった。',
    );
  }
  const pageTwo = await journal.listPage({
    conversationId: target,
    limit: 1,
    after: pageOne.next,
  });
  expectIds('4: after と併用できる', `listPage の続き（after=next）`, pageTwo.entries, [
    targetHuman.id,
  ]);
  if (pageTwo.next !== null) {
    fail('4: after と併用できる', '対象の会話の最後の頁なのに next が null ではなかった。');
  }

  // --- 契約5 ---
  const doomedRow = await exchange('doomed', doomed);
  expectIds(
    '5: 墓標のある会話は外れる',
    `墓標を積む前の list({ conversationId: doomed })`,
    await journal.list({ conversationId: doomed }),
    [doomedRow.id],
  );
  await journal.append({
    type: 'conversation_deleted',
    deletedConversationId: doomed,
    deletedBy: 'operator',
    hiddenCount: 1,
  });
  expectIds(
    '5: 墓標のある会話は外れる',
    `墓標を積んだ後の list({ conversationId: doomed })`,
    await journal.list({ conversationId: doomed }),
    [],
  );

  // --- 契約6 ---
  expectIds(
    '6: 空文字は絞らないへ倒さない',
    `list({ conversationId: '' })`,
    await journal.list({ conversationId: '' }),
    [],
  );
}
