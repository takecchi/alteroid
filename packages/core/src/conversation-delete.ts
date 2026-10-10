import { lookupConversation, type ConversationLookup } from './conversation-lookup.js';
import { removeInboxEventsAndStopDelivery } from './inbox-backlog.js';
import { scanJournalPages } from './journal-scan.js';
import type { Stores } from './store.js';

/**
 * 人間との会話を論理削除する。
 *
 * **印は日誌の墓標の行（`conversation_deleted`）そのものである。** 墓標を積んだ時点で、日誌の3実装は
 * その会話の `exchange` を `list` / `listPage` / `get` から外す（`journal-deleted-conversation-contract.ts`）。
 * 既存の行は書き換えない（日誌は追記専用）。別表に印を持たないのは、印と監査の記録が別々に書けて
 * 「墓標は在るのに外れていない」「外れているのに墓標が無い」の片方だけの状態を作らないためである。
 *
 * **墓標を先に積む。** 墓標が積めなければ何も変えずに投げる。墓標の後の手当て（添付・台帳・受信箱・
 * 既読・進行中の購読）は1つずつ試し、落ちたものは `incomplete` に名前を残して続ける——会話は既に
 * どの読む口からも外れているので、途中で止めて「消せなかった」と言うより、残ったものを正直に言うほうが
 * 正しい。
 *
 * **本文はどこにも写さない**（墓標にも、戻り値にも）。
 */
export interface DeleteConversationDeps {
  stores: Pick<
    Stores,
    'journal' | 'attachments' | 'commitments' | 'inbox' | 'conversationReads' | 'jobs'
  >;
  /** 受信箱の待ち行列から落とす口（`CloneHost.dropQueuedInboxEvents`）。 */
  dropQueuedInboxEvents: (ids: readonly string[]) => Promise<number>;
  /** 進行中の購読・途中経過を落とす口（`CloneHost.forgetConversation`）。無い器では落とせなかったと言う。 */
  forgetConversation?: (conversationId: string) => void;
}

export type DeleteConversationResult =
  | { deleted: false; lookup: Extract<ConversationLookup, { found: false }> }
  | {
      deleted: true;
      conversationId: string;
      tombstoneId: string;
      deletedAt: string;
      /** 読む口から外れた発言の件数（墓標を積む直前に数えた値）。 */
      hiddenCount: number;
      attachmentsRemoved: number;
      commitmentsRemoved: number;
      /** 受信箱から外した、まだ処理していない人間の発言の件数。 */
      queuedDropped: number;
      /** この会話に結び付いた承認の件数（承認は外さない）。 */
      approvalsLinked: number;
      /** 墓標の後の手当てのうち、落ちたもの（何が残ったかを言う）。 */
      incomplete: string[];
      /** 消していない（消せない）が、この会話の中身が残りうる場所。人間へ見せる文。 */
      remainsIn: string[];
    };

/**
 * 消した会話の中身が残りうる場所。**どれもこの削除では消していない。**
 * 生ログは会話 id で引けず、途中を抜くと resume が壊れうるので、外科的には消さない。
 */
export const CONVERSATION_DELETE_REMAINS: readonly string[] = [
  'クローンの SDK セッションの生ログ（session_entries）と archive、いま走っているセッションの文脈には、この会話の発言が残っている（会話の単位では消せない）。秘密を書いたのなら、#4173 のセッションの開き直しと、その鍵の作り直しをすること',
  '既に蒸留された記憶と、書き終えた日報に写っている可能性がある。記憶と日報を確かめること',
  'この会話に結び付いた承認（ask_human・request_permission）の問いと答えの本文は消していない（決着の記録なので外さない。台帳に残る「承認待ち … への回答」の行も同じ）。承認の一覧・各承認の画面・台帳で確かめること',
  '会話 id を持たない日誌の行（ask_human の問いと答え・クローンの道具の呼び出しの入力・マネージャーとの往復）には、言い換えや写しが残りうる',
  '台帳のこの会話の行（人間の手で積んだ行とクローンが載せた行）は消し、その本文を写した日誌の行（積んだ・直した・片付けたとき）も読む口から外した。ただし、台帳をまとめて片付けた日誌の行（閉じた id の並びと理由）と、クローンが自分の言葉で言い換えて日誌に書いた行は、会話との結び付きが分からないので残りうる',
  'クローンやマネージャーが作業ディレクトリへ写した添付は、時間で消えるまで残る',
];

/**
 * この会話が削除済みか（墓標が在るか）。日誌の外の口（進行中のターンの途中経過を流す SSE など）が、
 * 消した会話を見せないために使う。墓標は会話の数に比べて少ないので、墓標の種別だけを読む。
 */
export async function isConversationDeleted(
  journal: Pick<Stores['journal'], 'listPage'>,
  conversationId: string,
): Promise<boolean> {
  let deleted = false;
  await scanJournalPages(journal, { types: ['conversation_deleted'] }, (page) => {
    deleted = page.some(
      (entry) =>
        entry.type === 'conversation_deleted' && entry.deletedConversationId === conversationId,
    );
    return !deleted;
  });
  return deleted;
}

/**
 * 墓標に id を持たせて外す: 台帳の行の本文を写した `decision` 行は会話 id を持たないので、墓標の会話 id では外れないため。
 *
 * 一括で片付けた行（`閉じた id: a b c`）は拾わない: 本文を写しておらず、ほかの台帳の行の記録も含むため。
 * 墓標を積む前に集める。集められなければ投げて、何も変えない（隠しそこねた写しを残したまま「消した」と言わないため）。
 */
async function findCommitmentCopies(
  stores: Pick<Stores, 'journal' | 'commitments'>,
  conversationId: string,
): Promise<string[]> {
  const { entries } = await stores.commitments.list({ includeClosed: true });
  const markers = entries
    .filter(
      (entry) =>
        (entry.origin === 'human' || entry.origin === 'self') && entry.source === conversationId,
    )
    .map((entry) => `（${entry.id}）`);
  if (markers.length === 0) return [];
  const found: string[] = [];
  await scanJournalPages(stores.journal, { types: ['decision'] }, (page) => {
    for (const entry of page) {
      if (entry.type !== 'decision') continue;
      if (markers.some((marker) => entry.decision.includes(marker))) found.push(entry.id);
    }
    return true;
  });
  return found;
}

export async function deleteConversation(
  deps: DeleteConversationDeps,
  input: { conversationId: string; deletedBy: string },
): Promise<DeleteConversationResult> {
  const { stores } = deps;
  const { conversationId, deletedBy } = input;

  const lookup = await lookupConversation(stores.journal, conversationId);
  if (!lookup.found) return { deleted: false, lookup };

  let hiddenCount = 0;
  const attachmentIds = new Set<string>();
  await scanJournalPages(stores.journal, { types: ['exchange'], with: ['human'] }, (page) => {
    for (const entry of page) {
      if (entry.type !== 'exchange' || entry.conversationId !== conversationId) continue;
      hiddenCount += 1;
      for (const ref of entry.attachments ?? []) attachmentIds.add(ref.id);
    }
    return true;
  });

  const hiddenEntryIds = await findCommitmentCopies(stores, conversationId);

  const tombstone = await stores.journal.append({
    type: 'conversation_deleted',
    deletedConversationId: conversationId,
    deletedBy,
    hiddenCount,
    ...(hiddenEntryIds.length === 0 ? {} : { hiddenEntryIds }),
  });

  const incomplete: string[] = [];
  const attempt = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      incomplete.push(`${what}（${error instanceof Error ? error.message : String(error)}）`);
      return fallback;
    }
  };

  const queuedDropped = await attempt(
    '受信箱の未処理の発言を外す',
    async () => {
      const peek = await stores.inbox.peekPending();
      const ids = peek.entries
        .filter(
          (row) =>
            row.event.type === 'human_message' && row.event.conversationId === conversationId,
        )
        .map((row) => row.event.id);
      if (ids.length === 0) return 0;
      const outcome = await removeInboxEventsAndStopDelivery(
        stores.inbox,
        { dropQueuedInboxEvents: deps.dropQueuedInboxEvents },
        ids,
      );
      return outcome.removedIds.length;
    },
    0,
  );

  if (deps.forgetConversation === undefined) {
    incomplete.push('進行中の購読と途中経過を落とす（この器には落とす口が無い）');
  } else {
    const forget = deps.forgetConversation;
    await attempt('進行中の購読と途中経過を落とす', async () => forget(conversationId), undefined);
  }

  // 1件ずつ消す: `remove` は生きていた（期限内の）ものを消したときだけ true を返し、期限切れの残骸も消す
  const attachmentsRemoved = await attempt(
    '添付を消す',
    async () => {
      let removed = 0;
      for (const id of attachmentIds) if (await stores.attachments.remove(id)) removed += 1;
      return removed;
    },
    0,
  );

  const commitmentsRemoved = await attempt(
    '台帳からこの会話の行を消す',
    () => stores.commitments.removeForConversation(conversationId),
    0,
  );

  // 未読に数え続けないよう、既読の位置を消した時刻まで進める（索引の行は会話 id と時刻だけで、本文は無い）
  await attempt(
    '既読の位置を進める',
    async () => {
      await stores.conversationReads.advance(conversationId, tombstone.at);
    },
    undefined,
  );

  const approvalsLinked = await attempt(
    '結び付いた承認を数える',
    async () => (await stores.jobs.listApprovals({ conversationId })).entries.length,
    0,
  );

  return {
    deleted: true,
    conversationId,
    tombstoneId: tombstone.id,
    deletedAt: tombstone.at,
    hiddenCount,
    attachmentsRemoved,
    commitmentsRemoved,
    queuedDropped,
    approvalsLinked,
    incomplete,
    remainsIn: [...CONVERSATION_DELETE_REMAINS],
  };
}
