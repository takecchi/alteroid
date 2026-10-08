import { scanJournalPages } from './journal-scan.js';
import type { JournalStore } from './store.js';

/**
 * 渡された会話 id が、既存の会話として在るかを日誌から確かめる（Issue #4149）。
 *
 * **会話は日誌の `exchange`（`with: 'human'`）の `conversationId` の集まりとして暗黙に在る。**
 * だから書く側が id を確かめずに書けば、書いた時点で「その文字列の会話」が生まれる。
 * 略記の `bf63fd3d` を渡された `conversation_post` が、`bf63fd3d-93d2-…` の続きではなく
 * `bf63fd3d` という新しい会話を作り、同じ話が人間の画面で2つの会話に分かれた（#4149）。
 * **新しい会話を始めてよいのは id を省いたときだけで、渡された id は既存の会話を指すこと。**
 * それを書く口（`conversation_post`・`POST /chat`）がここを通して確かめる。
 *
 * **窓（`scan`）で切らない。** 一覧の窓の外にある古い会話へ書くのは正当なので、窓で切ると
 * 「在る会話を無いと断る」になる。在る会話は新しい側から読んで見つけ次第止める（使われている
 * 会話ほど日誌の新しい側に在る）。無いと言うときだけ、人間との往復を最後まで読む。
 *
 * **前方一致で救わない。** 略記が一意でも、それを黙って完全な id へ読み替えると、略記が
 * たまたま別の会話にも当たるようになった日に、別の会話へ書く（取り違えは分かれるより悪い）。
 * 候補は断る文言に出すためだけに集める。
 */
export type ConversationLookup =
  | { found: true }
  | {
      found: false;
      /** 渡された id で始まる既存の会話 id（新しい順、最大 {@link CONVERSATION_CANDIDATE_LIMIT} 件）。 */
      candidates: string[];
      /** 前方一致する会話が上限より多く在ったか。 */
      moreCandidates: boolean;
    };

export const CONVERSATION_CANDIDATE_LIMIT = 5;

export async function lookupConversation(
  journal: Pick<JournalStore, 'listPage'>,
  conversationId: string,
): Promise<ConversationLookup> {
  let found = false;
  const candidates = new Set<string>();
  let moreCandidates = false;
  await scanJournalPages(journal, { types: ['exchange'], with: ['human'] }, (page) => {
    for (const entry of page) {
      if (entry.type !== 'exchange' || entry.conversationId === undefined) continue;
      if (entry.conversationId === conversationId) {
        found = true;
        return false;
      }
      if (
        entry.conversationId.startsWith(conversationId) &&
        !candidates.has(entry.conversationId)
      ) {
        if (candidates.size < CONVERSATION_CANDIDATE_LIMIT) candidates.add(entry.conversationId);
        else moreCandidates = true;
      }
    }
    return true;
  });
  return found ? { found: true } : { found: false, candidates: [...candidates], moreCandidates };
}

/**
 * 「その会話は無い」の文言。**新しく始めるなら id を省く、を必ず含める**（呼び手が次の一手を
 * 文言だけで決められるように）。前方一致の候補が1つなら完全な id を出す（それでも読み替えはしない）。
 */
export function describeMissingConversation(
  conversationId: string,
  lookup: Extract<ConversationLookup, { found: false }>,
): string {
  const head =
    `会話 ${conversationId} は無い（日誌の人間との往復を最後まで読んで見つからなかった）。` +
    '既存の会話へ書くなら、会話 id を完全な形で渡すこと。新しい会話を始めるなら conversationId を省くこと。';
  const [only] = lookup.candidates;
  if (lookup.candidates.length === 1 && !lookup.moreCandidates && only !== undefined) {
    return `${head} ${conversationId} で始まる会話は1つだけ在る: ${only}`;
  }
  if (lookup.candidates.length > 1) {
    return (
      `${head} ${conversationId} で始まる会話が複数在る: ${lookup.candidates.join(', ')}` +
      (lookup.moreCandidates ? ' ほか' : '')
    );
  }
  return head;
}
