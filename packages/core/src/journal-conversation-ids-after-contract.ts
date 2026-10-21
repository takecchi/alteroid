import { JournalAnchorNotFoundError } from './store.js';
import type { JournalCursor, JournalStore } from './store.js';
import { scanJournalPages } from './journal-scan.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
// 時刻の待ちは使わない: 同じミリ秒に積まれても成り立つよう、`until` の期待値は積んだ行の `at` から自分で導く。
// 口は省略可能（`JournalStore.conversationIdsAfter`）だが、3実装は持つので、持たないことを契約の破れとして扱う
export type JournalStoreConversationIdsAfterContractSubject = Pick<
  JournalStore,
  'append' | 'listPage' | 'conversationIdsAfter'
>;

const MARKER = 'journal-conversation-ids-after-contract';

function fail(property: string, detail: string): never {
  throw new Error(
    `JournalStore の継続点より後ろの会話 id の契約（${property}）が破れている — ${detail}`,
  );
}

function plusMs(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

export async function verifyJournalStoreConversationIdsAfterContract(
  journal: JournalStoreConversationIdsAfterContractSubject,
): Promise<void> {
  const idsAfter = journal.conversationIdsAfter?.bind(journal);
  if (idsAfter === undefined) fail('口', 'conversationIdsAfter を持っていない');

  const conv = (name: string) => `${MARKER}:${name}`;
  const exchange = (
    withWhom: 'human' | 'manager' | 'self',
    role: 'inbound' | 'outbound',
    conversationId: string | undefined,
  ) =>
    journal.append({
      type: 'exchange',
      with: withWhom,
      role,
      text: MARKER,
      ...(conversationId === undefined ? {} : { conversationId }),
    });

  // 錨より前の人間との往復: 錨より古い側は含まない
  await exchange('human', 'inbound', conv('before'));
  const anchor = await exchange('human', 'inbound', conv('anchor'));
  const cursor: JournalCursor = { id: anchor.id, at: anchor.at };

  // 他の相手・他の種別の行を挟む: `with` や種別で絞らない実装が、これらの会話 id を拾わないため
  await exchange('manager', 'inbound', conv('manager'));
  await exchange('self', 'outbound', conv('self'));
  await journal.append({ type: 'decision', decision: `${MARKER}: 別の種別`, grounds: 'g' });
  // 会話 id を持たない人間との往復は、id の集合に何も足さない
  await exchange('human', 'inbound', undefined);

  // 同じ会話の往復を重ねる: 同じ会話が2度返らない
  const first = await exchange('human', 'inbound', conv('dup'));
  await exchange('human', 'outbound', conv('dup'));
  await exchange('human', 'inbound', conv('dup'));

  // 消した会話・墓標が名指しした行は、`listPage` と同じく外れる
  await exchange('human', 'inbound', conv('deleted'));
  const named = await exchange('human', 'inbound', conv('named'));
  await journal.append({
    type: 'conversation_deleted',
    deletedConversationId: conv('deleted'),
    deletedBy: 'operator',
    hiddenCount: 0,
    hiddenEntryIds: [named.id],
  });

  const mid = await exchange('human', 'outbound', conv('mid'));
  const last = await exchange('human', 'inbound', conv('last'));
  const late = await exchange('human', 'inbound', conv('late'));

  // 他の契約が積んだ行の会話 id が混ざることは契約の破れではない: 自分の印の付いた id だけを見る
  const mine = (ids: readonly string[]): string[] =>
    ids.filter((id) => id.startsWith(`${MARKER}:`)).sort();
  const asKey = (ids: readonly string[]): string => mine(ids).join(', ');

  const visible = [
    { id: first.id, at: first.at, conversationId: conv('dup') },
    { id: mid.id, at: mid.at, conversationId: conv('mid') },
    { id: last.id, at: last.at, conversationId: conv('last') },
    { id: late.id, at: late.at, conversationId: conv('late') },
  ];
  const expected = (until?: string): string =>
    [
      ...new Set(
        visible
          .filter((row) => until === undefined || row.at <= until)
          .map((row) => row.conversationId),
      ),
    ]
      .sort()
      .join(', ');

  const whole = await idsAfter({ after: cursor });
  const seen = new Set<string>();
  for (const id of mine(whole)) {
    if (seen.has(id)) fail('重複', `会話 ${id} が2度返った`);
    seen.add(id);
  }
  if (asKey(whole) !== expected()) {
    fail(
      '錨より後ろ',
      `錨より後ろの人間との往復の会話 id だけが返るはずが [${asKey(whole)}]、期待は [${expected()}]（錨の行・錨より前・他の相手・他の種別・消した会話・名指しされた行のどれかを含めた、または落とした）`,
    );
  }

  // `listPage` を最後まで読んだ結果と揃う: 口を持つ器と持たない器で、続きの頁の中身が変わらないため
  const viaPages = new Set<string>();
  await scanJournalPages(
    journal,
    { types: ['exchange'], with: ['human'], order: 'asc', after: cursor },
    (page) => {
      for (const entry of page) {
        if (entry.type === 'exchange' && entry.conversationId !== undefined) {
          viaPages.add(entry.conversationId);
        }
      }
    },
    { pageSize: 2 },
  );
  if (asKey(whole) !== asKey([...viaPages])) {
    fail(
      'listPage との一致',
      `listPage を最後まで読むと [${asKey([...viaPages])}]、口の答えは [${asKey(whole)}]`,
    );
  }

  // `until` ちょうどの行を含み、それより後ろは外れる（`listPage` の `until` と同じ境界）
  for (const row of [first, mid, last]) {
    const cut = await idsAfter({ after: cursor, until: row.at });
    if (asKey(cut) !== expected(row.at)) {
      fail(
        'until',
        `until = ${row.at} の答えが [${asKey(cut)}]、期待は [${expected(row.at)}]（until の後ろを含めた、または until ちょうどの行を落とした）`,
      );
    }
  }
  const beforeAll = await idsAfter({ after: cursor, until: plusMs(anchor.at, -1) });
  if (mine(beforeAll).length !== 0) {
    fail('until', `錨より前の until なのに会話 id が返っている [${asKey(beforeAll)}]`);
  }

  // 錨が見つからないときは、黙って空や全件へ倒さず `listPage` と同じ例外を投げる
  for (const missing of [
    { id: `${MARKER}-missing`, at: anchor.at },
    { id: anchor.id, at: plusMs(anchor.at, 1) },
  ]) {
    let thrown: unknown;
    try {
      await idsAfter({ after: missing });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof JournalAnchorNotFoundError)) {
      fail(
        '錨',
        `見つからない錨（id=${missing.id}, at=${missing.at}）で JournalAnchorNotFoundError を投げるはずが [${String(thrown)}]`,
      );
    }
  }
}
