import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
// 時刻の待ちは使わない: 同じミリ秒に積まれても成り立つ形にする。
// 印だけを引く口（`withdrawnClientMessageIds`）に直に掛ける: 全部の器（fs・pg・インメモリ）が持つ
type JournalStoreWithdrawnContractSubject = Pick<
  JournalStore,
  'append' | 'list' | 'withdrawnClientMessageIds'
>;

const MARKER = 'journal-withdrawn-contract';
const EPOCH = '1970-01-01T00:00:00.000Z';

function fail(property: string, detail: string): never {
  throw new Error(`JournalStore の取り下げの印の契約（${property}）が破れている — ${detail}`);
}

// 重なって返ってもよい（並びと重複は口の契約に無い。呼び手が集合にする）
function sorted(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(', ');
}

export async function verifyJournalStoreWithdrawnContract(
  journal: JournalStoreWithdrawnContractSubject,
): Promise<void> {
  const conversation = `${MARKER}-conv`;
  const other = `${MARKER}-other`;

  const mark = (conversationId: string, clientMessageId: string) =>
    journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${MARKER}: 取り下げた ${clientMessageId}`,
      conversationId,
      withdrawnClientMessageId: clientMessageId,
    });
  const plainSelf = (conversationId: string) =>
    journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${MARKER}: 印の無い内部の行`,
      conversationId,
    });

  const first = await mark(conversation, 'cm-1');
  await mark(other, 'cm-other');
  await plainSelf(conversation);
  const human = await journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: `${MARKER}: 人間の発言`,
    conversationId: conversation,
    clientMessageId: 'cm-human',
  });

  const back = (await journal.list({ types: ['exchange'], with: ['self'] })).find(
    (entry) => entry.id === first.id,
  );
  if (back === undefined || back.type !== 'exchange' || back.withdrawnClientMessageId !== 'cm-1') {
    fail('書き戻し', '印の行の withdrawnClientMessageId が list で読み戻せない');
  }

  const withdrawn = journal.withdrawnClientMessageIds.bind(journal);

  const collected = await withdrawn({ since: EPOCH, conversationId: conversation });
  if (sorted(collected) !== 'cm-1') {
    fail(
      '絞り',
      `同じ会話の印だけが集まるはずが [${sorted(collected)}]（別の会話の印・人間の行が混ざる、または cm-1 が欠ける）`,
    );
  }

  const after = new Date(Date.parse(human.at) + 1).toISOString();
  const none = await withdrawn({ since: after, conversationId: conversation });
  if (none.length !== 0) {
    fail('since', `since より前の印が集まっている [${sorted(none)}]`);
  }

  for (let i = 0; i < 5; i += 1) await plainSelf(conversation);
  await mark(conversation, 'cm-late');
  const later = await withdrawn({ since: EPOCH, conversationId: conversation });
  if (sorted(later) !== 'cm-1, cm-late') {
    fail(
      '頁',
      `間に印の無い行を挟んでも両方の印が集まるはずが [${sorted(later)}]（頁の継続で後ろの印を読み落としている）`,
    );
  }
}
