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
 *
 * **畳み込み規則を持つのも、ここ1か所である**（`computeSupersededIds`。
 * チャットの「メッセージを編集する」機能）。編集は日誌に「`supersedes` を
 * 持つ新しい `exchange` の追記」として残り（`schema.ts` の `journalEntrySchema`
 * の `exchange.supersedes` の doc）、日誌のレコード自体は1件も変わらない —
 * ここが計算するのは**射影**（どの id を既定ビューから隠すか）だけである。
 * `conversationMessages` と `collectConversations` の両方がこの1つの関数を
 * 通す。手で書き直した場所ができるたびに、窓の絞り込み（上）と同じ形の欠陥
 * — 片方だけ規則を直し忘れる余地 — が生まれる。
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
  /**
   * この発言が置き換える、過去の人間の発言の id（編集後の発言が持つ。
   * `schema.ts` の `exchange.supersedes` をそのまま写す）。
   */
  supersedes?: string;
  /**
   * この発言を隠している編集の id（畳み込みで隠された側だけが持つ）。
   * **既定ビュー（`includeSuperseded` を渡さない呼び出し）には現れない** —
   * 隠された発言そのものが返り値から除かれるため。`includeSuperseded: true`
   * で取り出したときにだけ、どの編集がこれを隠したかを示す。
   */
  supersededBy?: string;
}

/**
 * `supersedes` を持つ発言による畳み込み（チャットの「メッセージを編集する」
 * 機能）で、どの発言を隠すか・どの編集が隠したかを計算する。
 *
 * **`conversationMessages` と `collectConversations` の両方がこの関数を通す**
 * （モジュール冒頭の doc「畳み込み規則を持つのも、ここ1か所である」）。
 *
 * **入力は1つの会話ぶんの発言を古い順に並べたものである**（呼び出し側の
 * 責任。並びが古い順でなければ結果は保証しない）。会話をまたいだ配列を渡しても、
 * `conversationId` が違えば下の防御的条件でスキップされるが、そもそも
 * 意図した使い方ではない。
 *
 * 規則（issue「チャットの送信済みメッセージを編集する」の「畳み込み規則」）:
 * - `supersedes: T` を持つ発言 E について、T の位置 `i` と E の位置 `j` を
 *   探す。`i` 以上 `j` 未満の**すべて**（旧発言 T と、それに対する応答、
 *   およびそれ以降 E までの往復）を隠す
 * - 隠す集合は**全編集の和集合**として計算する — 編集の編集（連鎖）が
 *   自然に畳まれるのはこのためである
 * - **T が見つからない**（`scan` の窓の外へ落ちた）、**T が E より後ろにある**
 *   （順序が逆）、**T の会話が E と違う**——このいずれかに当たる編集は
 *   **何も隠さない**（防御的に無視する。落ちてはいけない）
 *
 * 戻り値は「隠された発言の id」→「どの編集がそれを隠したか（E の id）」の
 * 対応。**先に付いた理由を優先し、上書きしない** — 連鎖編集で同じ発言が
 * 複数回範囲に入ることは無い（各編集の隠す範囲は互いに素になる）はずだが、
 * 万一重なってもここで最初の理由を保つ。
 */
export function computeSupersededIds(chronological: Exchange[]): Map<string, string> {
  const indexById = new Map<string, number>();
  chronological.forEach((entry, index) => indexById.set(entry.id, index));

  const supersededBy = new Map<string, string>();
  chronological.forEach((entry, j) => {
    const target = entry.supersedes;
    if (target === undefined) return;
    const i = indexById.get(target);
    if (i === undefined) return; // T が窓の中に見つからない — 何も隠さない
    if (i >= j) return; // T が E と同じか後ろ（順序が逆）— 防御的にスキップ
    const supersededEntry = chronological[i];
    // `i` は上の `indexById` から取れた、この配列自身の添字なので必ず存在する。
    // `noUncheckedIndexedAccess` は添字アクセスそのものからは境界を証明できないため、
    // ここだけ非null断定で通す。
    if (supersededEntry === undefined || supersededEntry.conversationId !== entry.conversationId) {
      return; // 会話違い — 防御的にスキップ
    }
    for (let k = i; k < j; k += 1) {
      const hiddenId = chronological[k]?.id;
      if (hiddenId !== undefined && !supersededBy.has(hiddenId))
        supersededBy.set(hiddenId, entry.id);
    }
  });
  return supersededBy;
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
 *
 * **`preview` と `messages` は畳んだ後で数える**（`computeSupersededIds` の
 * doc）。編集で隠された旧発言が一覧の抜粋・件数に出続けるのは誤りなので、
 * 会話ごとに古い順へ組み直してから畳み込みを適用し、残った発言だけで
 * `startedAt` / `updatedAt` / `messages` / `preview` を数える。
 */
export function collectConversations(entries: JournalEntry[]): ConversationSummary[] {
  // 会話ごとに、新しい順のまま束ねる（`order` は「最初に出会った」＝最新発言の
  // 順を保つ——元の Map 実装と同じ並びにするため）。
  const byConversation = new Map<string, Exchange[]>();
  const order: string[] = [];
  for (const entry of humanExchanges(entries)) {
    const id = entry.conversationId;
    if (id === undefined) continue;
    let bucket = byConversation.get(id);
    if (bucket === undefined) {
      bucket = [];
      byConversation.set(id, bucket);
      order.push(id);
    }
    bucket.push(entry);
  }

  const summaries: ConversationSummary[] = [];
  for (const id of order) {
    const newestFirst = byConversation.get(id);
    if (newestFirst === undefined) continue; // 型のための防御（起こらない）
    const chronological = [...newestFirst].reverse();
    const supersededBy = computeSupersededIds(chronological);
    const visible = chronological.filter((entry) => !supersededBy.has(entry.id));
    if (visible.length === 0) continue; // 畳んだ結果、残る発言が無い（起こらないはずだが防御的に）
    // 直前の `length === 0` 判定で非空は分かっているが、`noUncheckedIndexedAccess`
    // は添字アクセスからは境界を証明できないため非null断定で通す。
    const first = visible[0]!;
    const last = visible[visible.length - 1]!;
    summaries.push({
      conversationId: id,
      startedAt: first.at,
      updatedAt: last.at,
      messages: visible.length,
      preview: preview(last.text),
    });
  }
  return summaries;
}

/**
 * 1つの会話の中身を古い順に取り出す。
 *
 * **既定（`includeSuperseded` を渡さない）では畳んだ後を返す。** 編集で
 * 隠された旧発言・その応答は除かれ、残った発言には `supersedes` /
 * `supersededBy` が付く（畳み込み規則は `computeSupersededIds` を見よ）。
 *
 * **`includeSuperseded: true` を渡すと、畳まれた分も含めて古い順で返す。**
 * 隠された発言には `supersededBy`（どの編集が隠したか）が付く。「(A)
 * `conversation_read` から畳まれた版へ届くこと」を満たすための取り出し口
 * ——呼び出し側（HTTP API / CLI / クローンの道具）は、この配列から
 * `supersededBy !== undefined` を数えれば「畳まれた版が何件あるか」を言える。
 */
export function conversationMessages(
  entries: JournalEntry[],
  conversationId: string,
  options: { includeSuperseded?: boolean } = {},
): ConversationMessage[] {
  const chronological = humanExchanges(entries)
    .filter((entry) => entry.conversationId === conversationId)
    .reverse();
  const supersededBy = computeSupersededIds(chronological);
  const messages = chronological.map((entry) => {
    const hiddenBy = supersededBy.get(entry.id);
    return hiddenBy === undefined
      ? toMessage(entry)
      : { ...toMessage(entry), supersededBy: hiddenBy };
  });
  if (options.includeSuperseded) return messages;
  return messages.filter((message) => message.supersededBy === undefined);
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

/**
 * `exchange` を発言1件へ落とす。
 *
 * **`supersedes` は在るときだけ付ける。** 無いのに `undefined` のキーを
 * 持たせると、`toEqual` での比較や JSON 化のときに「持っているが空」と
 * 「持っていない」が混ざる（AGENTS.md「取れない軸に 0 の行を作る」と同じ形）。
 */
export function toMessage(entry: Exchange): ConversationMessage {
  return {
    id: entry.id,
    at: entry.at,
    role: entry.role,
    text: entry.text,
    conversationId: entry.conversationId,
    ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
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
