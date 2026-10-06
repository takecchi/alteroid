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

import type { ConversationReadView } from './conversation-read.js';
import { compareIsoInstant } from './iso-instant.js';
import type { AttachmentRef, JournalEntry } from './schema.js';
import { UnreadableJournalEntryError, type JournalCursor, type JournalStore } from './store.js';

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
  /**
   * 未読の数（`countUnread`）。**窓（`scan`）の中で数えた値である**（窓の外は数えていない）。
   * 既読の記録を渡さずに作った要約では、位置が無いものとして数える。
   */
  unread: number;
  /**
   * 実効の既読の位置（`effectiveReadThrough`）。**この時刻以前の発言は既読。**
   * 基準時刻も決まっていない（記録が読めない）ときだけ `null`。
   */
  readThrough: string | null;
}

/**
 * 会話の実効の既読の位置。**会話に記録された位置と基準時刻の遅いほう**（基準時刻は床）。
 * 位置が無ければ基準時刻、基準時刻が無ければ位置、どちらも無ければ `null`（全件未読）。
 *
 * 基準時刻を床にするのは、基準時刻より前の古い発言を指して既読にしたとき、位置が基準時刻より
 * 古くなって、間の返答が未読へ戻る（後戻りする）のを防ぐため。
 */
export function effectiveReadThrough(
  view: ConversationReadView,
  conversationId: string,
): string | null {
  const position = view.positions[conversationId]?.readThrough ?? null;
  if (position === null) return view.baseline;
  if (view.baseline === null) return position;
  return compareIsoInstant(position, view.baseline) >= 0 ? position : view.baseline;
}

/**
 * 未読の数。**クローン側の発言（`with: 'human'` の `outbound` ——返答・失敗ターンの返答・
 * `conversation_post`）だけを数える。** 人間自身の発言（`inbound`）は未読にしない。
 *
 * 入力は**既定ビューで見えている**発言（編集で隠れていないもの）にすること——隠れた発言を
 * 数えると、画面に出ない発言が未読として残る。`at` が `readThrough` より後のものを数える
 * （同時刻は既読）。`readThrough` が `null` なら全件を数える。
 */
export function countUnread(
  visible: readonly { role: 'inbound' | 'outbound'; at: string }[],
  readThrough: string | null,
): number {
  return visible.filter(
    (message) =>
      message.role === 'outbound' &&
      (readThrough === null || compareIsoInstant(message.at, readThrough) > 0),
  ).length;
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
  /**
   * 返信ではなく「返せなかった」知らせである印（`schema.ts` の `exchange.turnFailure` を
   * そのまま写す）。付いていなければ通常の発言（または印を持たない古い行）。
   */
  turnFailure?: 'failed' | 'held';
  /**
   * 発言に添えた添付の参照（`schema.ts` の `exchange.attachments` をそのまま写す。メタデータだけで中身は無い）。
   * 添付の無い発言には付けない。
   */
  attachments?: AttachmentRef[];
  /**
   * 送った側が付けた発言の id（`schema.ts` の `exchange.clientMessageId` をそのまま写す。Issue #3203）。
   * 付けずに届いた発言（別の経路・古い行）には付けない。
   */
  clientMessageId?: string;
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
  options: {
    scan: number;
    since?: string;
    until?: string;
    /** 古い順で読む（既定は新しい順）。取り込みが前へ向かって進むための形。 */
    order?: 'asc' | 'desc';
    /** 頁の継続点（`JournalQuery.after`）。 */
    after?: { id: string; at: string };
  },
): Promise<JournalEntry[]> {
  return journal.list({
    limit: options.scan,
    ...(options.order === undefined ? {} : { order: options.order }),
    ...(options.after === undefined ? {} : { after: options.after }),
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

const EMPTY_VIEW: ConversationReadView = { baseline: null, positions: {} };

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
export function collectConversations(
  entries: JournalEntry[],
  readView: ConversationReadView = EMPTY_VIEW,
): ConversationSummary[] {
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
    const readThrough = effectiveReadThrough(readView, id);
    const first = visible[0]!;
    const last = visible[visible.length - 1]!;
    // **一覧の題は、失敗の知らせではない最後の発言から取る。** 失敗した会話が全部同じ固定文の題で
    // 並ぶのを避ける（`turnFailure` の doc）。知らせしか無い会話だけが、知らせを題にする。
    const titled = [...visible].reverse().find((entry) => entry.turnFailure === undefined) ?? last;
    summaries.push({
      conversationId: id,
      startedAt: first.at,
      updatedAt: last.at,
      messages: visible.length,
      // 添付だけで本文が空の発言は、一覧の抜粋が空になるので件数で示す。
      preview:
        titled.text.trim() === '' &&
        titled.attachments !== undefined &&
        titled.attachments.length > 0
          ? `[添付 ${titled.attachments.length} 件]`
          : preview(titled.text),
      unread: countUnread(visible, readThrough),
      readThrough,
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
    ...(entry.turnFailure === undefined ? {} : { turnFailure: entry.turnFailure }),
    ...(entry.attachments === undefined || entry.attachments.length === 0
      ? {}
      : { attachments: entry.attachments }),
    ...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }),
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

/**
 * 会話の一覧の頁の継続点。**日誌の頁の継続点（`JournalCursor` = `{ id, at }`）と同じ形である。**
 *
 * 指すのは次のどちらかで、呼ぶ側はどちらかを区別しない（応答の `nextCursor` をそのまま返す）。
 * - 頁の最後の会話の**最新の人間との発言**（`limit` で切れて、窓の中にまだ会話が残るとき）
 * - 窓（`scan`）の最後に読んだ発言（窓の中の会話は出し切ったが、窓が日誌の先頭に届いていないとき）
 */
export type ConversationCursor = JournalCursor;

/**
 * 継続点が使えないときに投げる。呼び出し側（HTTP）が 400 へ変換する。**黙って先頭へ倒さない**
 * （`JournalAnchorNotFoundError` と同じ理由。継続点が引けないのは「判定できない」である）。
 */
export class InvalidConversationCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConversationCursorError';
  }
}

/** 継続点より新しい側にある人間との発言の会話 id を、全部集める際の1回の読み出し幅。 */
const NEWER_IDS_PAGE = 1000;

/**
 * 会話の一覧の1頁。`GET /conversations` の応答の元になる。
 *
 * **並びは、会話ごとの「最新の人間との発言」の日誌の順序（新しい順）である**（`collectConversations`
 * が最初に出会った順に並べるのと同じ）。日誌は追記専用で既存の行の前後が動かないので、継続点
 * （発言の `{ id, at }`）で辿れば、同じミリ秒に複数の会話の最新発言が並んでいても、飛ばさず重複しない
 * （`at` では割れない同着は日誌の順序が割る）。
 */
export interface ConversationPage {
  conversations: ConversationSummary[];
  /** この頁で読んだ人間との発言の数（継続点があれば、その先から数える）。 */
  scanned: number;
  /** この頁の窓が日誌の先頭に届いたか（`reachedStart`）。 */
  reachedStart: boolean;
  /** この窓の中で `limit` に収まらず、この頁に載せなかった会話の数。 */
  hiddenByLimit: number;
  /**
   * 次の頁の継続点。**`null` = 続きは無い**（窓の中の会話を出し切り、窓が日誌の先頭にも届いた）。
   * `hiddenByLimit > 0` か `reachedStart === false` のどちらかなら非 `null`。
   */
  next: ConversationCursor | null;
}

/**
 * 継続点より**新しい**側にある人間との発言を持つ会話の id を全部集める。
 *
 * 継続点より古い側の窓に現れる会話のうち、これに入っているものは、すでに前の頁までで出した会話の
 * 古い発言である（会話の位置は最新の発言で決まるので、新しい側に発言が在れば、その会話は継続点より
 * 前に並んでいる）。**それを出し直すと重複になる**ので、窓の側から除く。
 */
async function conversationIdsNewerThan(
  journal: Pick<JournalStore, 'listPage'>,
  anchor: ConversationCursor,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: JournalCursor = anchor;
  for (;;) {
    const page = await journal.listPage({
      types: ['exchange'],
      with: ['human'],
      order: 'asc',
      after,
      limit: NEWER_IDS_PAGE,
    });
    for (const entry of page.entries) {
      if (entry.type === 'exchange' && entry.conversationId !== undefined) {
        ids.add(entry.conversationId);
      }
    }
    if (page.next === null) return ids;
    after = page.next;
  }
}

/**
 * 会話の一覧の1頁を読む（`GET /conversations` と、同じ並びを辿る口が共有する）。
 *
 * - `cursor` が無ければ、日誌の新しいほうから `scan` 件の窓（従来と同じ）。
 * - `cursor` が在れば、その発言**より古い**側から `scan` 件の窓を読み、継続点より新しい側に発言を持つ
 *   会話（前の頁までに出した会話）を除く。**窓の外へも、継続点を辿れば進める。**
 *
 * `scanned` / `reachedStart` / `hiddenByLimit` の意味は従来のまま（頁の窓についての値）。
 * 窓は頁ごとに読み直すので、**会話の `messages` / `startedAt` / `preview` は、その窓の中で数えた値**である
 * （窓をまたいで古い発言を持つ会話は、窓の外を数えていない。従来の `scan` の注意と同じ）。
 *
 * ⚠️ 継続点が指す発言は日誌に実在し、人間との往復でなければならない。そうでなければ
 * `InvalidConversationCursorError`。
 */
export async function readConversationPage(
  journal: Pick<JournalStore, 'list' | 'listPage' | 'get'>,
  options: {
    limit: number;
    scan: number;
    cursor?: ConversationCursor;
    readView?: ConversationReadView;
  },
): Promise<ConversationPage> {
  const { limit, scan, cursor, readView } = options;
  let exclude: ReadonlySet<string> = new Set();
  if (cursor !== undefined) {
    let anchor: JournalEntry | null;
    try {
      anchor = await journal.get(cursor.id);
    } catch (error) {
      if (error instanceof UnreadableJournalEntryError) {
        throw new InvalidConversationCursorError('カーソルが指す発言が読めない');
      }
      throw error;
    }
    if (
      anchor === null ||
      anchor.at !== cursor.at ||
      anchor.type !== 'exchange' ||
      anchor.with !== 'human'
    ) {
      throw new InvalidConversationCursorError('カーソルが指す発言が見当たらない');
    }
    const newer = await conversationIdsNewerThan(journal, cursor);
    if (anchor.conversationId !== undefined) newer.add(anchor.conversationId);
    exclude = newer;
  }

  const entries = await readConversationWindow(journal, {
    scan,
    ...(cursor === undefined ? {} : { after: cursor }),
  });
  const fresh =
    exclude.size === 0
      ? entries
      : entries.filter(
          (entry) =>
            !(
              entry.type === 'exchange' &&
              entry.conversationId !== undefined &&
              exclude.has(entry.conversationId)
            ),
        );

  // 会話の位置（最新の発言）。`collectConversations` と同じく、新しい順に最初に出会った発言。
  const headOf = new Map<string, JournalCursor>();
  for (const entry of humanExchanges(fresh)) {
    if (entry.conversationId !== undefined && !headOf.has(entry.conversationId)) {
      headOf.set(entry.conversationId, { id: entry.id, at: entry.at });
    }
  }

  const all = collectConversations(fresh, readView);
  const conversations = all.slice(0, limit);
  const hiddenByLimit = all.length - conversations.length;
  const reached = reachedStart(entries.length, scan);

  let next: ConversationCursor | null = null;
  const lastShown = conversations[conversations.length - 1];
  if (hiddenByLimit > 0 && lastShown !== undefined) {
    next = headOf.get(lastShown.conversationId) ?? null;
  } else if (!reached) {
    // 窓の中の会話は出し切った。窓の外が残るので、窓の最後に読んだ発言から続ける。
    const lastRead = entries[entries.length - 1];
    if (lastRead !== undefined) next = { id: lastRead.id, at: lastRead.at };
  }
  return { conversations, scanned: entries.length, reachedStart: reached, hiddenByLimit, next };
}
