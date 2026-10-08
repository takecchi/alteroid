import { readWithdrawnClientMessageIds } from './conversation.js';
import type { JournalStore } from './store.js';

/**
 * `JournalStore` の「取り下げの印」の契約（issue #3990）。
 *
 * 順番待ちの発言を取り下げたとき、クローンは `withdrawnClientMessageId` を持つ `exchange`
 * （`with: 'self'`）を日誌へ足す。`GET /conversations/:id` の発言の `delivery: 'withdrawn'` は、
 * これを `readWithdrawnClientMessageIds` で読んで作る。3実装（インメモリ / `storage-fs` /
 * `storage-pg`）が、この印を書き戻し・`with` と `since` で絞り・頁をまたいで読めることを測る。
 *
 * **vitest に依存しない素の非同期関数にしてある**（`journal-deleted-conversation-contract.ts` と同じ理由）。
 * 食い違ったら `throw` する。`append` した行は残る（後始末はしない）ので、使い捨てのストアを渡すこと。
 * 時刻の待ちは使わない（同じミリ秒に積まれても成り立つ形にしてある）。
 *
 * 測る性質:
 *
 * 1. 印の行が `withdrawnClientMessageId` ごと読み戻せる
 * 2. 同じ会話の印だけが集まる（別の会話・印の無い `self` の行・`human` の行は集まらない）
 * 3. 全部より後ろの `since` では何も集まらない
 * 4. 間に印の無い行が頁の大きさより多く挟まっても、後ろの印を読み落とさない
 */
export type JournalStoreWithdrawnContractSubject = Pick<JournalStore, 'append' | 'list'>;

const MARKER = 'journal-withdrawn-contract';
const EPOCH = '1970-01-01T00:00:00.000Z';

function fail(property: string, detail: string): never {
  throw new Error(`JournalStore の取り下げの印の契約（${property}）が破れている — ${detail}`);
}

function sorted(set: ReadonlySet<string>): string {
  return [...set].sort().join(', ');
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

  // 1: 書き戻し
  const back = (await journal.list({ types: ['exchange'], with: ['self'] })).find(
    (entry) => entry.id === first.id,
  );
  if (back === undefined || back.type !== 'exchange' || back.withdrawnClientMessageId !== 'cm-1') {
    fail('書き戻し', '印の行の withdrawnClientMessageId が list で読み戻せない');
  }

  // 2: 絞り
  const collected = await readWithdrawnClientMessageIds(journal, conversation, EPOCH);
  if (sorted(collected) !== 'cm-1') {
    fail(
      '絞り',
      `同じ会話の印だけが集まるはずが [${sorted(collected)}]（別の会話の印・人間の行が混ざる、または cm-1 が欠ける）`,
    );
  }

  // 3: 全部より後ろの since
  const after = new Date(Date.parse(human.at) + 1).toISOString();
  const none = await readWithdrawnClientMessageIds(journal, conversation, after);
  if (none.size !== 0) {
    fail('since', `since より前の印が集まっている [${sorted(none)}]`);
  }

  // 4: 頁の大きさ（ここでは 2）より多い行が間に挟まっても読み落とさない
  for (let i = 0; i < 5; i += 1) await plainSelf(conversation);
  await mark(conversation, 'cm-late');
  const paged = await readWithdrawnClientMessageIds(journal, conversation, EPOCH, 2);
  if (sorted(paged) !== 'cm-1, cm-late') {
    fail(
      '頁',
      `頁をまたいで両方の印が集まるはずが [${sorted(paged)}]（頁の継続で後ろの印を読み落としている）`,
    );
  }
}
