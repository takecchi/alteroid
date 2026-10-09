import type { JournalEntry } from './schema.js';
import type { JournalStore } from './store.js';

/**
 * `JournalStore` の「消した会話を外す」契約を、実装1つに対して測る（issue #4218）。
 *
 * 会話の論理削除は、日誌へ追記する墓標の行（`type: 'conversation_deleted'`）だけを印にする。
 * 墓標のある会話の `exchange` は、**ストアの中で** `list` / `listPage` / `get` から外れる
 * （読む口の側で1つずつ外すと、外し忘れた口から消した会話が漏れるため）。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか。** `journal-with-contract.ts` の doc と
 * 同じ理由（`storage-fs` / `storage-pg` が `@alteroid/core` を実行時の依存として読むため）。
 * 食い違ったら `throw` する。
 *
 * **測る6性質。3実装（インメモリ / `storage-fs` / `storage-pg`）すべてがこれを呼ぶこと。
 * 呼んでいない実装が増えたら `scripts/journal-store-with-contract-registry.test.ts` が落ちる。**
 *
 * 1. 墓標の前は見える。墓標の後は `list`・`listPage`・`get`・`q` 検索・`with: ['human']` の
 *    どれからも外れる
 * 2. 別の会話・`conversationId` を持たない行・墓標の行そのものは外れない
 * 3. 外すのは `limit` より前（消した会話の行を新しい側に多数積んでも、`limit: 1` で消していない
 *    会話の行が1件返る。`listPage` の `next` も、外した行を数えて誤らない）
 * 4. 墓標の後に同じ会話へ積んだ行も外れる
 * 5. 墓標が `hiddenEntryIds` で名指しした行（会話 id を持たない本文の写し。#4355）も、どの読み口からも外れる。名指ししていない行は外れない
 * 6. `oldestAt` は、読み口に見えている行のうち最古の `at` を返す（外した行の時刻を返さない。#4377）。
 *    外した行と見えている行が同じミリ秒なら差は出ないが、そのときは時刻からも漏れない
 *
 * `append` した行は呼び出し側のストアへ実際に残る（後始末はしない）。使い捨てのストアを渡すこと。
 */
export type JournalStoreDeletedConversationContractSubject = Pick<
  JournalStore,
  'append' | 'list' | 'listPage' | 'get' | 'oldestAt'
>;

const MARKER = 'journal-deleted-conversation-contract';

function fail(property: string, detail: string): never {
  throw new Error(`JournalStore の墓標の契約（${property}）が破れている — ${detail}`);
}

function ids(entries: readonly JournalEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

export async function verifyJournalStoreDeletedConversationContract(
  journal: JournalStoreDeletedConversationContractSubject,
): Promise<void> {
  const deleted = `${MARKER}-deleted`;
  const kept = `${MARKER}-kept`;

  const exchange = (text: string, conversationId: string | undefined) =>
    journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: `${MARKER}: ${text}`,
      ...(conversationId === undefined ? {} : { conversationId }),
    });

  // 積む順序が契約3の要である: 消した会話の行（a2〜a4）を、消していない会話の行（kept）より新しい側に置く。
  const before = await exchange('deleted-before', deleted);
  const noConversation = await exchange('no-conversation', undefined);
  const keptRow = await exchange('kept', kept);
  const newerBefore: JournalEntry[] = [];
  for (let i = 0; i < 3; i += 1) {
    newerBefore.push(await exchange(`deleted-newer-${i}`, deleted));
  }

  // --- 契約1（前半）: 墓標の前は見える ---
  const visibleBefore = ids(await journal.list({ types: ['exchange'] }));
  for (const row of [before, ...newerBefore, noConversation, keptRow]) {
    if (!visibleBefore.includes(row.id)) {
      fail('1: 墓標の前は見える', `墓標を積む前に list が行（id=${row.id}）を返さなかった。`);
    }
  }
  if ((await journal.get(before.id))?.id !== before.id) {
    fail('1: 墓標の前は見える', `墓標を積む前に get(${before.id}) が行を返さなかった。`);
  }

  // --- 墓標を積む（普通の append。積んだ直後から効く） ---
  const tombstone = await journal.append({
    type: 'conversation_deleted',
    deletedConversationId: deleted,
    deletedBy: 'operator',
    hiddenCount: 1 + newerBefore.length,
  });

  // --- 契約4: 墓標の後に同じ会話へ積んだ行も外れる ---
  const after = await exchange('deleted-after', deleted);
  const hidden = [before, ...newerBefore, after];

  // --- 契約1（後半）: 墓標の後は、どの読み口からも外れる ---
  const surfaces: Record<string, string[]> = {
    list: ids(await journal.list()),
    'list(types: exchange)': ids(await journal.list({ types: ['exchange'] })),
    'list(order: asc)': ids(await journal.list({ order: 'asc' })),
    'list(with: human)': ids(await journal.list({ with: ['human'] })),
    'list(q)': ids(await journal.list({ q: MARKER })),
    listPage: ids((await journal.listPage()).entries),
    'listPage(q)': ids((await journal.listPage({ q: MARKER })).entries),
  };
  for (const [surface, found] of Object.entries(surfaces)) {
    for (const row of hidden) {
      if (found.includes(row.id)) {
        fail(
          row.id === after.id ? '4: 墓標の後に積んだ行も外れる' : '1: 墓標の後は外れる',
          `${surface} が、墓標のある会話の行（id=${row.id}）を返した。`,
        );
      }
    }
  }
  for (const row of hidden) {
    const got = await journal.get(row.id);
    if (got !== null) {
      fail(
        row.id === after.id ? '4: 墓標の後に積んだ行も外れる' : '1: 墓標の後は外れる',
        `get(${row.id}) が行を返した（null のはずである）。`,
      );
    }
  }

  // --- 契約2: 別の会話・conversationId の無い行・墓標そのものは外れない ---
  // 墓標を返すはずの口: 絞り（types / with / q）の無い口だけ（絞りのある口は exchange の行だけを見る）
  const tombstoneSurfaces = new Set(['list', 'list(order: asc)', 'listPage']);
  for (const [surface, found] of Object.entries(surfaces)) {
    const expected = tombstoneSurfaces.has(surface)
      ? [noConversation, keptRow, tombstone]
      : [noConversation, keptRow];
    for (const row of expected) {
      if (!found.includes(row.id)) {
        fail('2: 外れない', `${surface} が、外す対象ではない行（id=${row.id}）を返さなかった。`);
      }
    }
  }
  for (const row of [noConversation, keptRow, tombstone]) {
    if ((await journal.get(row.id))?.id !== row.id) {
      fail('2: 外れない', `get(${row.id}) が、外す対象ではない行を返さなかった。`);
    }
  }
  const tombstoneRead = await journal.get(tombstone.id);
  if (
    tombstoneRead?.type !== 'conversation_deleted' ||
    tombstoneRead.deletedConversationId !== deleted
  ) {
    fail('2: 外れない', `get(墓標) が墓標の行を返さなかった: ${JSON.stringify(tombstoneRead)}`);
  }

  // --- 契約3: limit より前に効く ---
  // 新しい側に消した会話の行が4件（newerBefore 3 + after 1）と、さらに新しい墓標が在る。
  const windowed = await journal.list({ limit: 1, types: ['exchange'], with: ['human'] });
  if (windowed.length !== 1 || windowed[0]?.id !== keptRow.id) {
    fail(
      '3: limit より前に効く',
      `消した会話の行を新しい側に ${newerBefore.length + 1} 件積んだ状態で ` +
        `list({ limit: 1, types: ['exchange'], with: ['human'] }) を呼んだが、消していない会話の行` +
        `（id=${keptRow.id}）が1件返らなかった（実際に返った件数: ${windowed.length}）。`,
    );
  }
  const windowedPlain = await journal.list({ limit: 1, types: ['exchange'] });
  if (windowedPlain.length !== 1 || windowedPlain[0]?.id !== keptRow.id) {
    fail(
      '3: limit より前に効く',
      `list({ limit: 1, types: ['exchange'] }) が消していない会話の行（id=${keptRow.id}）を1件返さなかった。`,
    );
  }
  // 窓の終端: 見える exchange は kept / noConversation の2件だけ。limit: 2 で `next` は null（外した行を
  // 数えて「まだ先がある」と誤らない）、limit: 1 で `next` は非 null（見える行が残っている）。
  const pageTwo = await journal.listPage({ limit: 2, types: ['exchange'] });
  if (
    pageTwo.entries.length !== 2 ||
    pageTwo.entries[0]?.id !== keptRow.id ||
    pageTwo.entries[1]?.id !== noConversation.id ||
    pageTwo.next !== null
  ) {
    fail(
      '3: limit より前に効く',
      `listPage({ limit: 2, types: ['exchange'] }) が [kept, noConversation] と next=null を返さなかった: ` +
        `entries=${JSON.stringify(ids(pageTwo.entries))} next=${JSON.stringify(pageTwo.next)}`,
    );
  }
  const pageOne = await journal.listPage({ limit: 1, types: ['exchange'] });
  if (pageOne.entries[0]?.id !== keptRow.id || pageOne.next === null) {
    fail(
      '3: limit より前に効く',
      `listPage({ limit: 1, types: ['exchange'] }) が [kept] と next（非 null）を返さなかった: ` +
        `entries=${JSON.stringify(ids(pageOne.entries))} next=${JSON.stringify(pageOne.next)}`,
    );
  }
  const nextPage = await journal.list({ types: ['exchange'], limit: 1, after: pageOne.next });
  if (nextPage[0]?.id !== noConversation.id) {
    fail(
      '3: limit より前に効く',
      `次の頁（after=next）の先頭が noConversation（id=${noConversation.id}）ではなかった: ` +
        `${JSON.stringify(ids(nextPage))}`,
    );
  }

  // --- 契約5（#4355）: 墓標が `hiddenEntryIds` で名指しした行は、会話 id を持たなくても外れる ---
  const decision = (text: string) =>
    journal.append({ type: 'decision', decision: `${MARKER}: ${text}`, grounds: MARKER });
  const copy = await decision('copy-of-deleted-body');
  const unrelated = await decision('unrelated-decision');
  await journal.append({
    type: 'conversation_deleted',
    deletedConversationId: `${MARKER}-deleted-2`,
    deletedBy: 'operator',
    hiddenCount: 0,
    hiddenEntryIds: [copy.id],
  });
  const namedSurfaces: Record<string, string[]> = {
    list: ids(await journal.list()),
    'list(types: decision)': ids(await journal.list({ types: ['decision'] })),
    'list(q)': ids(await journal.list({ q: MARKER })),
    listPage: ids((await journal.listPage()).entries),
  };
  for (const [surface, found] of Object.entries(namedSurfaces)) {
    if (found.includes(copy.id)) {
      fail(
        '5: 名指しした行も外れる',
        `${surface} が、墓標が名指しした行（id=${copy.id}）を返した。`,
      );
    }
    if (!found.includes(unrelated.id)) {
      fail(
        '5: 名指しした行も外れる',
        `${surface} が、名指ししていない行（id=${unrelated.id}）まで外した。`,
      );
    }
  }
  if ((await journal.get(copy.id)) !== null) {
    fail('5: 名指しした行も外れる', `get(${copy.id}) が行を返した（null のはずである）。`);
  }
  if ((await journal.get(unrelated.id))?.id !== unrelated.id) {
    fail('5: 名指しした行も外れる', `get(${unrelated.id}) が、名指ししていない行を返さなかった。`);
  }

  // --- 契約6（#4377）: oldestAt は見えている行のうち最古の at ---
  const visibleOldest = (await journal.list({ order: 'asc', limit: 1 }))[0]?.at ?? null;
  const oldestAt = await journal.oldestAt();
  if (oldestAt !== visibleOldest) {
    fail(
      '6: oldestAt は外した行の時刻を返さない',
      `oldestAt() が ${String(oldestAt)} を返したが、見えている行の最古は ${String(visibleOldest)} である。`,
    );
  }
}
