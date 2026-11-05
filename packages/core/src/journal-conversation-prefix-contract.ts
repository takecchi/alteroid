import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
// 時刻の待ちは使わない: 同じミリ秒に積まれても、並びは日誌の順序が決める。
// 他の契約が積んだ行と混ざらないよう、会話 id は全部 `MARKER` で始め、前方一致の引きも `MARKER` で始める。
type JournalStoreConversationPrefixContractSubject = Pick<
  JournalStore,
  'append' | 'conversationIdsWithPrefix'
>;

const MARKER = 'journal-conversation-prefix-contract';

function fail(property: string, detail: string): never {
  throw new Error(`JournalStore の会話 id の前方一致の契約（${property}）が破れている — ${detail}`);
}

export async function verifyJournalStoreConversationPrefixContract(
  journal: JournalStoreConversationPrefixContractSubject,
): Promise<void> {
  const withPrefix = journal.conversationIdsWithPrefix.bind(journal);
  const conv = (name: string) => `${MARKER}:${name}`;
  const say = (withWhom: 'human' | 'manager' | 'self', conversationId: string, text = '発言') =>
    journal.append({
      type: 'exchange',
      with: withWhom,
      role: 'inbound',
      text,
      conversationId,
    });

  // `bf` で始まる会話を 7 つ。最新の発言の順を、作った順と入れ替える（並びは会話ごとの最新の発言の新しい順）
  for (let i = 0; i < 7; i += 1) await say('human', conv(`bf-000${String(i)}`));
  await say('human', conv('bf-0002'), '0002 に新しい発言（並びの先頭へ）');
  await say('human', conv('bf-0005'), '0005 に新しい発言（並びの先頭へ）');
  // `cc` で始まる会話は 1 つ（長い本文）
  await say('human', conv('cc-aaaa'), `長い本文 ${'あ'.repeat(5000)}`);
  // `ge` で始まる会話は人間との往復が 1 つだけ残る: 消した会話・マネージャー・自分だけの往復は数えない
  await say('human', conv('ge-kept'));
  await say('human', conv('ge-gone'));
  await journal.append({
    type: 'conversation_deleted',
    deletedConversationId: conv('ge-gone'),
    deletedBy: 'operator',
    hiddenCount: 1,
  });
  await say('manager', conv('ge-manager'));
  await say('self', conv('ge-self'));

  const newestFirst = [
    'bf-0005',
    'bf-0002',
    'bf-0006',
    'bf-0004',
    'bf-0003',
    'bf-0001',
    'bf-0000',
  ].map(conv);
  const show = (ids: readonly string[]): string => `[${ids.join(', ')}]`;
  const expectIds = (property: string, actual: readonly string[], expected: readonly string[]) => {
    if (show(actual) !== show(expected)) {
      fail(property, `期待は ${show(expected)}、実際は ${show(actual)}`);
    }
  };

  expectIds('並び・重複', await withPrefix({ prefix: conv('bf'), limit: 100 }), newestFirst);
  expectIds('上限', await withPrefix({ prefix: conv('bf'), limit: 6 }), newestFirst.slice(0, 6));
  expectIds('上限', await withPrefix({ prefix: conv('bf'), limit: 2 }), newestFirst.slice(0, 2));
  expectIds('完全一致', await withPrefix({ prefix: conv('bf-0002'), limit: 6 }), [conv('bf-0002')]);
  expectIds('1 件だけ', await withPrefix({ prefix: conv('cc'), limit: 6 }), [conv('cc-aaaa')]);
  expectIds('当たらない', await withPrefix({ prefix: conv('zz'), limit: 6 }), []);
  expectIds('消した会話・他の相手', await withPrefix({ prefix: conv('ge'), limit: 6 }), [
    conv('ge-kept'),
  ]);
}
