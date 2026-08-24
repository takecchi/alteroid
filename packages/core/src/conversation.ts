/**
 * 人間との会話を、日誌から組み立てて読み返す。
 *
 * **逐語はもう残っている。読む口が無かっただけである。** クローンが人間と交わした
 * 発言は1件ずつ日誌の `exchange`（`with: 'human'`）として全文で積まれていて
 * （`clone.ts` の `#record`）、`archive` と違って compaction にも器の入れ替えにも
 * 左右されない。人間はこれを `GET /conversations` と CLI の `alteroid conversations`
 * から読める。**同じものがクローンの道具に無いのは能力の削除である**
 * （north_star 禁止1。`manager_transcript` が塞いだ穴と同じ形）。
 *
 * ここに置くのは日誌の並びを会話へ畳み直す規則だけで、状態は持たない
 * （`app.ts` の `/conversations` が持っている規則と同じものである）。
 *
 * **会話の走査窓を組み立てるのも、ここ1か所である**（`readConversationWindow`。
 * issue #418）。`GET /conversations` / `GET /conversations/:id` / クローンの
 * `conversation_read` の3口が、それぞれ手で `journal.list({ types: ['exchange'],
 * ... })` を組み立てていたため、`with`（誰との往復か）を `types` の後にしか
 * 絞れず、`scan` の予算をマネージャー / 内部ターンとの往復が食い尽くして
 * 人間の会話が窓の外へ落ちていた。**窓の条件（`types` / `with` / `since` /
 * `until`）を持つのはこの関数だけで、状態は持たない** — 呼ぶたびにストアへ
 * 素通しするだけである。
 */

import type { JournalEntry } from './schema.js';
import type { JournalStore } from './store.js';

/** 日誌の `exchange` 1件。 */
export type Exchange = Extract<JournalEntry, { type: 'exchange' }>;

/** 一覧に出す短い抜粋の長さ。 */
export const CONVERSATION_PREVIEW = 80;

/**
 * 一覧に出す短い抜粋。全文は会話の中身のほうにある。
 *
 * **`excerpt.ts` の `excerptLine` を使っていない。** あちらは省いた分量を必ず本文へ
 * 書くが、ここは `GET /conversations` の `preview` としてそのまま人間の画面と CLI に
 * 出ている値なので、**挙動を変えないためにこの形のまま持ってきた**（`app.ts` から
 * 移設しただけで、1文字も変えていない）。省いた分量を言わない点は `excerpt.ts` の
 * 立てている線と食い違うが、直すなら人間側の表示の変更として別に諮ること。
 */
export function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= CONVERSATION_PREVIEW ? flat : `${flat.slice(0, CONVERSATION_PREVIEW)}…`;
}

export interface ConversationSummary {
  conversationId: string;
  /** 遡った窓の中でいちばん古い発言の時刻。**会話の実際の開始とは限らない。** */
  startedAt: string;
  updatedAt: string;
  /** 遡った窓の中で数えた発言数。**窓の外は数えていない。** */
  messages: number;
  preview: string;
}

export interface ConversationMessage {
  /** 日誌のエントリ id。全文はここから引ける。 */
  id: string;
  at: string;
  /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
  role: 'inbound' | 'outbound';
  text: string;
  conversationId: string | undefined;
}

/**
 * 人間との往復だけを、日誌の順序（新しい順）のまま取り出す。
 *
 * **`with` で絞れるのがここの要点である。** 日誌には `manager` との往復と内部ターン
 * （`self`）が同じ `exchange` として混ざっていて、実際の運用では件数の大半がそちらに
 * なる。種別だけで絞ると、人間の発言は窓の外へ押し出されて二度と見えない。
 */
export function humanExchanges(entries: JournalEntry[]): Exchange[] {
  return entries.filter(
    (entry): entry is Exchange => entry.type === 'exchange' && entry.with === 'human',
  );
}

/**
 * 人間との会話を読む3口（`GET /conversations` / `GET /conversations/:id` /
 * `conversation_read`）が共有する、唯一の窓の組み立て（issue #418）。
 *
 * **`types: ['exchange']` と `with: ['human']` を持つのはここだけにする。**
 * かつては3口それぞれが `journal.list({ limit: scan, types: ['exchange'] })`
 * を手で組み立て、`with === 'human'` への絞りは返ってきた後（＝ `limit` の
 * 内側）で `humanExchanges` にやらせていた。日誌には `with: 'manager'`（マネー
 * ジャーとの往復）と `with: 'self'`（内部ターン）が同じ `exchange` として
 * 混ざっており、実運用では件数の大半がそちらになる — 窓を `types` だけで
 * 切ると、`scan` の予算をそれらが食い尽くし、人間の会話が窓の外へ押し出されて
 * 見えなくなる。
 *
 * **直したのは絞りの順序である。** `with: ['human']` を `journal.list` へ渡し、
 * ストアの側（`limit` より前）で絞らせる。`scan` の予算を食うのは、その時点で
 * 人間との往復に絞り込まれた行だけになる。3実装（`testing.ts` のインメモリ /
 * `storage-fs` / `storage-pg`）がこの契約を守ることは
 * `journal-with-contract.ts` の `verifyJournalStoreWithContract` が測る。
 *
 * **状態は持たない。** `scan` / `since` / `until` を受け取ってストアへ渡すだけで、
 * 呼ぶたびに独立している。
 */
export async function readConversationWindow(
  journal: Pick<JournalStore, 'list'>,
  options: { scan: number; since?: string; until?: string },
): Promise<JournalEntry[]> {
  return journal.list({
    limit: options.scan,
    types: ['exchange'],
    with: ['human'],
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.until === undefined ? {} : { until: options.until }),
  });
}

/** `role` で更に絞る。`'both'` は絞らない。 */
export function bySpeaker(exchanges: Exchange[], speaker: 'human' | 'clone' | 'both'): Exchange[] {
  if (speaker === 'both') return exchanges;
  const role = speaker === 'human' ? 'inbound' : 'outbound';
  return exchanges.filter((entry) => entry.role === role);
}

/**
 * 新しい順に並んだ `exchange` を会話ごとに畳む（新しい順のまま返す）。
 *
 * **`at` で並べ直さない。** 同じミリ秒に並んだ発言の前後は時刻からは決められない
 * ので、追記専用の記録が持っている順序のほうが、後から組み立てた順序より正しい
 * （`app.ts` の `/conversations` と同じ判断）。
 */
export function collectConversations(entries: JournalEntry[]): ConversationSummary[] {
  const conversations = new Map<string, ConversationSummary>();
  for (const entry of humanExchanges(entries)) {
    const id = entry.conversationId;
    if (id === undefined) continue;
    const found = conversations.get(id);
    if (found === undefined) {
      // 最初に出会うのが最新の発言（＝この会話の updatedAt と抜粋）
      conversations.set(id, {
        conversationId: id,
        startedAt: entry.at,
        updatedAt: entry.at,
        messages: 1,
        preview: preview(entry.text),
      });
      continue;
    }
    // 以降は古い方へ遡るので、開始時刻だけを更新していく
    found.startedAt = entry.at;
    found.messages += 1;
  }
  return [...conversations.values()];
}

/** 1つの会話の中身を古い順に取り出す。 */
export function conversationMessages(
  entries: JournalEntry[],
  conversationId: string,
): ConversationMessage[] {
  return humanExchanges(entries)
    .filter((entry) => entry.conversationId === conversationId)
    .reverse()
    .map(toMessage);
}

/**
 * 語で探す。**大文字小文字を区別しない単純な部分一致だけを持つ。**
 *
 * 正規表現も AND/OR も持たないのは、探し方を増やすより「窓のどこまでを見たか」を
 * 正直に返すほうが効くからである（見えなかったものは語の書き方では救えない）。
 * 新しい順のまま返す。
 */
export function searchExchanges(exchanges: Exchange[], query: string): ConversationMessage[] {
  const needle = query.toLowerCase();
  return exchanges.filter((entry) => entry.text.toLowerCase().includes(needle)).map(toMessage);
}

/** `exchange` を発言1件へ落とす。 */
export function toMessage(entry: Exchange): ConversationMessage {
  return {
    id: entry.id,
    at: entry.at,
    role: entry.role,
    text: entry.text,
    conversationId: entry.conversationId,
  };
}

/**
 * 遡った窓が日誌の先頭に届いたか。
 *
 * ストアは新しい順に最大 `scan` 件返すので、返ってきた数が頼んだ数に届かなければ
 * それ以上は無い＝先頭まで見た、と言える。**ちょうど同数のときはまだあるかもしれない
 * ので、届いていない側へ倒す**（`app.ts` の `/conversations/:id` と同じ安全側）。
 */
export function reachedStart(returned: number, scan: number): boolean {
  return returned < scan;
}
