import { readConversationWindowPage } from './conversation.js';
import { scanJournalPages } from './journal-scan.js';
import type { JournalStore } from './store.js';

/**
 * 渡された会話 id が、既存の会話として在るかを日誌から確かめる。
 *
 * **会話は日誌の `exchange`（`with: 'human'`）の `conversationId` の集まりとして暗黙に在る。**
 * だから書く側が id を確かめずに書けば、書いた時点で「その文字列の会話」が生まれる。
 * 略記の `bf63fd3d` を渡された旧 `conversation_post`（廃止済み。いまは `task_say` が宛先を task の起点に固定する）が、`bf63fd3d-93d2-…` の続きではなく
 * `bf63fd3d` という新しい会話を作り、同じ話が人間の画面で2つの会話に分かれた。
 * **新しい会話を始めてよいのは id を省いたときだけで、渡された id は既存の会話を指すこと。**
 * それを書く口（`POST /chat` ほか）がここを通して確かめる。
 *
 * **窓（`scan`）で切らない。** 一覧の窓の外にある古い会話へ書くのは正当なので、窓で切ると
 * 「在る会話を無いと断る」になる。在る会話は新しい側から読んで見つけ次第止める（使われている
 * 会話ほど日誌の新しい側に在る）。無いと言うときだけ、人間との往復を最後まで読む。
 *
 * **前方一致で救わない。** 略記が一意でも、それを黙って完全な id へ読み替えると、略記が
 * たまたま別の会話にも当たるようになった日に、別の会話へ書く（取り違えは分かれるより悪い）。
 * 候補は断る文言に出すためだけに集める。クローンの道具は、この上に `resolveConversationId` で
 * 「一意に決まる 8 文字以上の前方一致を、名乗ったうえで受け付ける」を足す（#5130）。
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
  journal: Pick<JournalStore, 'listPage' | 'conversationIdsWithPrefix'>,
  conversationId: string,
): Promise<ConversationLookup> {
  // 在る会話は、その会話の行だけを1行引いて答える（#5140）: 頁送りだと、古い会話ほど新しい側の他の会話を読み切るまで見つからないため。
  // 1行も返らなければ、下の頁送りへそのまま落とす: 候補（前方一致）を集めるのと、読めない行を捨てて空に見えた頁を「無い」と取り違えないのは頁送りの受け持ちのため
  const exact = await readConversationWindowPage(journal, { scan: 1, conversationId });
  if (exact.entries.some((entry) => entry.type === 'exchange')) return { found: true };

  // 前方一致の候補を DB で集める口を持つ器ではそちらを使う（#5140）: 頁送りは人間との往復を本文ごと全部運び、
  // クローンが会話 id の先頭 8 文字だけを渡すたびに（#5130）往復の総数ぶんの本文を読んでいたため
  if (journal.conversationIdsWithPrefix !== undefined) {
    const matched = await journal.conversationIdsWithPrefix({
      prefix: conversationId,
      limit: CONVERSATION_CANDIDATE_LIMIT + 1,
    });
    // 頁送りと同じく、完全一致が現れたら在る（1行目の確かめと頁送りの間に書かれた発言）
    if (matched.includes(conversationId)) return { found: true };
    return {
      found: false,
      candidates: matched.slice(0, CONVERSATION_CANDIDATE_LIMIT),
      moreCandidates: matched.length > CONVERSATION_CANDIDATE_LIMIT,
    };
  }

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

/** クローンの道具が前方一致を受け付ける、会話 id の先頭の最短の長さ（#5130）。 */
export const CONVERSATION_PREFIX_MIN_LENGTH = 8;

export type ConversationResolution =
  /** 渡された id の会話がそのまま在った。 */
  | { readonly kind: 'exact'; readonly id: string }
  /** 渡された id は先頭で、それで始まる会話がちょうど1つ在った。 */
  | { readonly kind: 'prefix'; readonly id: string }
  /** それで始まる会話が2つ以上在り、どれか決められない。 */
  | {
      readonly kind: 'ambiguous';
      readonly candidates: readonly string[];
      readonly moreCandidates: boolean;
    }
  /** 当たる会話が無い（前方一致の候補は、短すぎて受け付けなかったものも含めて lookup に在る）。 */
  | { readonly kind: 'missing'; readonly lookup: Extract<ConversationLookup, { found: false }> };

/**
 * クローンの道具に渡された会話 id を、既存の会話へ解決する（#5130）。
 * 記憶や報告には会話 id の先頭 8 文字（`c60b1940`）だけが出ることが多く、クローンが後ろを推測で補って「無い」と断られる誤りが続いたため、
 * **一意に決まる前方一致（8 文字以上）だけ**受け付ける。
 * `lookupConversation` の「前方一致で救わない」（取り違えは分かれるより悪い）を守る線:
 * - 完全一致を先に見る（#4150 の事故で `bf63fd3d` という文字どおりの会話が在り、それを前方一致で別の会話へ読み替えない）
 * - 前方一致は、いまこの時点で当たる会話がちょうど1つのときだけ。2つ以上なら決めずに断り、候補を返す
 * - 読み替えたことは呼び手が応答に名乗る（黙って読み替えない）
 * - 8 文字（16進で 32 ビット）より短い先頭は受け付けない: 短いほど別の会話と偶然重なるため
 * 人間の口（`POST /chat`）と会話の削除は、完全な id のまま（ここを通さない）。
 */
export async function resolveConversationId(
  journal: Pick<JournalStore, 'listPage' | 'conversationIdsWithPrefix'>,
  given: string,
): Promise<ConversationResolution> {
  const lookup = await lookupConversation(journal, given);
  if (lookup.found) return { kind: 'exact', id: given };
  const [only] = lookup.candidates;
  if (lookup.candidates.length > 1 || lookup.moreCandidates) {
    return {
      kind: 'ambiguous',
      candidates: lookup.candidates,
      moreCandidates: lookup.moreCandidates,
    };
  }
  if (only !== undefined && given.length >= CONVERSATION_PREFIX_MIN_LENGTH) {
    return { kind: 'prefix', id: only };
  }
  return { kind: 'missing', lookup };
}

/** 前方一致で読み替えたことの名乗り。応答の先頭に置く。 */
export function describeResolvedConversationPrefix(given: string, id: string): string {
  return `（会話 id の先頭 ${given} を、それで始まる唯一の会話 ${id} と読んだ）`;
}

/** 道具が会話 id を解決できなかったときの文言（`missing` / `ambiguous`）。 */
export function describeUnresolvedConversation(
  given: string,
  resolution: Extract<ConversationResolution, { kind: 'missing' | 'ambiguous' }>,
): string {
  if (resolution.kind === 'ambiguous') {
    return (
      `${given} で始まる会話が複数在るので、どれか決められない: ${resolution.candidates.join(', ')}` +
      (resolution.moreCandidates ? ' ほか' : '') +
      '。どれかの完全な id を渡すこと。'
    );
  }
  const [only] = resolution.lookup.candidates;
  const tooShort =
    only !== undefined &&
    resolution.lookup.candidates.length === 1 &&
    given.length < CONVERSATION_PREFIX_MIN_LENGTH
      ? `${given} で始まる会話は1つだけ在る（${only}）が、先頭が ${CONVERSATION_PREFIX_MIN_LENGTH} 文字より短いので読み替えなかった。`
      : '';
  return (
    `会話 ${given} は無い（日誌の人間との往復を最後まで読んで見つからなかった）。${tooShort}` +
    `既存の会話へ書くなら、会話 id を完全な形か、1つに決まる ${CONVERSATION_PREFIX_MIN_LENGTH} 文字以上の先頭で渡すこと。` +
    '新しい会話を始めるなら conversationId を省くこと。'
  );
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
