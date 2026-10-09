/**
 * 人間との会話を、日誌から組み立てて読み返す。状態は持たない。
 *
 * 窓の条件（`types` / `with` / `since` / `until`）と畳み込み規則（`computeSupersededIds`）は
 * ここ1か所だけが持つ。口ごとに手で組み立てると、片方だけ規則を直し忘れる余地ができる。
 */

import type { ConversationReadView } from './conversation-read.js';
import { codePointBoundary } from './excerpt.js';
import { compareIsoInstant } from './iso-instant.js';
import type { AttachmentRef, JournalEntry, TurnFailureKind } from './schema.js';
import { UnreadableJournalEntryError, type JournalCursor, type JournalStore } from './store.js';

/** 日誌の `exchange` 1件。 */
export type Exchange = Extract<JournalEntry, { type: 'exchange' }>;

/** 一覧に出す短い抜粋の長さ。 */
export const CONVERSATION_PREVIEW = 80;

/**
 * `excerpt.ts` の `excerptLine` を使わない: あちらは省いた分量を本文へ書くが、ここは
 * `GET /conversations` の `preview` として人間の画面と CLI にそのまま出ている値なので、
 * 変えるなら人間側の表示の変更として別に諮ること。
 */
export function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= CONVERSATION_PREVIEW
    ? flat
    : `${flat.slice(0, codePointBoundary(flat, CONVERSATION_PREVIEW))}…`;
}

export interface ConversationSummary {
  conversationId: string;
  /** 遡った窓の中でいちばん古い発言の時刻。**会話の実際の開始とは限らない。** */
  startedAt: string;
  updatedAt: string;
  /** 遡った窓の中で数えた発言数。**窓の外は数えていない。** */
  messages: number;
  preview: string;
  /** 窓（`scan`）の中で数えた未読の数。窓の外は数えていない。 */
  unread: number;
  readThrough: string | null;
}

/**
 * 基準時刻を床にする: 基準時刻より前の古い発言を指して既読にしたとき、位置が基準時刻より古くなって
 * 間の返答が未読へ戻る（後戻りする）のを防ぐため。
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
 * 入力は既定ビューで見えている発言（編集で隠れていないもの）にすること: 隠れた発言を数えると、
 * 画面に出ない発言が未読として残る。
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
  supersedes?: string;
  /** 既定ビューには現れない（隠された発言は返り値から除かれる）。`includeSuperseded: true` のときだけ付く。 */
  supersededBy?: string;
  turnFailure?: 'failed' | 'held';
  /** 種別を持たない古い行は `other` として運ぶ。文面から `auth` / `quota` へ読み替えない。 */
  turnFailureKind?: TurnFailureKind;
  attachments?: AttachmentRef[];
  clientMessageId?: string;
}

/**
 * `supersedes` を持つ発言 E について、T（`supersedes`）の位置 `i` 以上 E の位置 `j` 未満をすべて隠す。
 * 入力は1つの会話ぶんを古い順に並べたもの（呼び出し側の責任）。
 *
 * T が見つからない（窓の外）・T が E より後ろ・会話が違う編集は何も隠さない（落ちてはいけない）。
 * 先に付いた理由を上書きしない。
 */
export function computeSupersededIds(chronological: Exchange[]): Map<string, string> {
  const indexById = new Map<string, number>();
  chronological.forEach((entry, index) => indexById.set(entry.id, index));

  const supersededBy = new Map<string, string>();
  chronological.forEach((entry, j) => {
    const target = entry.supersedes;
    if (target === undefined) return;
    const i = indexById.get(target);
    if (i === undefined) return;
    if (i >= j) return;
    const supersededEntry = chronological[i];
    if (supersededEntry === undefined || supersededEntry.conversationId !== entry.conversationId) {
      return;
    }
    for (let k = i; k < j; k += 1) {
      const hiddenId = chronological[k]?.id;
      if (hiddenId !== undefined && !supersededBy.has(hiddenId))
        supersededBy.set(hiddenId, entry.id);
    }
  });
  return supersededBy;
}

/** 人間との往復だけを、日誌の順序（新しい順）のまま取り出す。 */
export function humanExchanges(entries: JournalEntry[]): Exchange[] {
  return entries.filter(
    (entry): entry is Exchange => entry.type === 'exchange' && entry.with === 'human',
  );
}

/**
 * 人間との会話を読む口が共有する唯一の窓の組み立て。`with: ['human']` を `limit` より前のストア側で
 * 絞らせる: 返ってきた後で絞ると、マネージャー / 内部ターン（`self`）との往復が `scan` の予算を
 * 食い尽くして人間の会話が窓の外へ押し出される。
 */
export async function readConversationWindow(
  journal: Pick<JournalStore, 'list'>,
  options: {
    scan: number;
    since?: string;
    until?: string;
    order?: 'asc' | 'desc';
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

export function bySpeaker(exchanges: Exchange[], speaker: 'human' | 'clone' | 'both'): Exchange[] {
  if (speaker === 'both') return exchanges;
  const role = speaker === 'human' ? 'inbound' : 'outbound';
  return exchanges.filter((entry) => entry.role === role);
}

const WITHDRAWN_PAGE = 500;

/**
 * 取り下げの印の行（`with: 'self'`）は人間との往復の窓（`with: ['human']`）に入らないので、
 * `with: ['self']` を別に読む。`since` 以降を古い順に頁で読み切る（途中で黙って打ち切らない）。
 */
export async function readWithdrawnClientMessageIds(
  journal: Pick<JournalStore, 'list'>,
  conversationId: string,
  since: string,
  pageSize: number = WITHDRAWN_PAGE,
): Promise<Set<string>> {
  const withdrawn = new Set<string>();
  let after: JournalCursor | undefined;
  for (;;) {
    const page: JournalEntry[] = await journal.list({
      limit: pageSize,
      order: 'asc',
      types: ['exchange'],
      with: ['self'],
      since,
      ...(after === undefined ? {} : { after }),
    });
    for (const entry of page) {
      if (
        entry.type === 'exchange' &&
        entry.conversationId === conversationId &&
        entry.withdrawnClientMessageId !== undefined
      ) {
        withdrawn.add(entry.withdrawnClientMessageId);
      }
    }
    const last = page[page.length - 1];
    if (page.length < pageSize || last === undefined) return withdrawn;
    if (after?.id === last.id) {
      throw new Error('取り下げの印を読む頁の継続点が進まない（ストアが `after` を守っていない）');
    }
    after = { id: last.id, at: last.at };
  }
}

const EMPTY_VIEW: ConversationReadView = { baseline: null, positions: {} };

/**
 * `at` で並べ直さない: 同じミリ秒の発言の前後は時刻では決められず、追記専用の記録の順序のほうが正しい。
 * `preview` と `messages` は畳んだ後で数える（隠された旧発言を一覧に出し続けないため）。
 */
export function collectConversations(
  entries: JournalEntry[],
  readView: ConversationReadView = EMPTY_VIEW,
): ConversationSummary[] {
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
    if (newestFirst === undefined) continue;
    const chronological = [...newestFirst].reverse();
    const supersededBy = computeSupersededIds(chronological);
    const visible = chronological.filter((entry) => !supersededBy.has(entry.id));
    if (visible.length === 0) continue;
    const readThrough = effectiveReadThrough(readView, id);
    const first = visible[0]!;
    const last = visible[visible.length - 1]!;
    // 題は失敗の知らせではない最後の発言から取る: 失敗した会話が全部同じ固定文の題で並ぶのを避ける。
    const titled = [...visible].reverse().find((entry) => entry.turnFailure === undefined) ?? last;
    summaries.push({
      conversationId: id,
      startedAt: first.at,
      updatedAt: last.at,
      messages: visible.length,
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

/** 1つの会話の中身を古い順に取り出す。既定は畳んだ後。`includeSuperseded: true` で畳まれた分も返す。 */
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
 * 大文字小文字を区別しない単純な部分一致だけを持つ。正規表現も AND/OR も持たない: 探し方を増やすより
 * 「窓のどこまでを見たか」を正直に返すほうが効く（見えなかったものは語の書き方では救えない）。
 */
export function searchExchanges(exchanges: Exchange[], query: string): ConversationMessage[] {
  const needle = query.toLowerCase();
  return exchanges.filter((entry) => entry.text.toLowerCase().includes(needle)).map(toMessage);
}

/** 任意の欄は在るときだけ付ける: `undefined` のキーを持たせると「持っているが空」と「持っていない」が混ざる。 */
export function toMessage(entry: Exchange): ConversationMessage {
  return {
    id: entry.id,
    at: entry.at,
    role: entry.role,
    text: entry.text,
    conversationId: entry.conversationId,
    ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
    ...(entry.turnFailure === undefined
      ? {}
      : { turnFailure: entry.turnFailure, turnFailureKind: entry.turnFailureKind ?? 'other' }),
    ...(entry.attachments === undefined || entry.attachments.length === 0
      ? {}
      : { attachments: entry.attachments }),
    ...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }),
  };
}

/** ちょうど同数のときはまだあるかもしれないので、届いていない側へ倒す。 */
export function reachedStart(returned: number, scan: number): boolean {
  return returned < scan;
}

export type ConversationCursor = JournalCursor;

/**
 * `GET /conversations` と `conversation_read` の cursor は同じ符号化を通る。両側で書き写さない:
 * 片方だけ直すと、人間の口の cursor がクローンの道具で読めなくなる（その逆も）。
 */
export function encodeConversationCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify({ id: cursor.id, at: cursor.at }), 'utf8').toString(
    'base64url',
  );
}

/** 読めなければ `null`。指す発言が実在するかは `readConversationPage` が確かめる。 */
export function decodeConversationCursor(raw: string): ConversationCursor | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const { id, at } = json as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof at !== 'string' || at === '') return null;
  return { id, at };
}

/** 黙って先頭へ倒さない: 継続点が引けないのは「判定できない」であるため（`JournalAnchorNotFoundError` と同じ）。 */
export class InvalidConversationCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConversationCursorError';
  }
}

const NEWER_IDS_PAGE = 1000;

/**
 * 並びは会話ごとの最新の人間との発言の日誌の順序。継続点（`{ id, at }`）で辿れば、同じミリ秒の同着も
 * 日誌の順序が割るので、飛ばさず重複しない。
 */
export interface ConversationPage {
  conversations: ConversationSummary[];
  /** この頁で読んだ人間との発言の数（継続点があれば、その先から数える）。 */
  scanned: number;
  reachedStart: boolean;
  /** この窓の中で `limit` に収まらず、この頁に載せなかった会話の数。 */
  hiddenByLimit: number;
  /** `null` = 続きは無い。 */
  next: ConversationCursor | null;
  /** 会話ごとの最新の人間との発言の位置（`conversations` に載らなかった会話も含む）。 */
  positions: ReadonlyMap<string, ConversationCursor>;
}

/** 継続点より新しい側に発言を持つ会話は前の頁までで出し済みなので、それを出し直して重複させないために集める。 */
async function conversationIdsNewerThan(
  journal: Pick<JournalStore, 'listPage'>,
  anchor: ConversationCursor,
  until?: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: JournalCursor = anchor;
  for (;;) {
    const page = await journal.listPage({
      types: ['exchange'],
      with: ['human'],
      order: 'asc',
      after,
      ...(until === undefined ? {} : { until }),
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
 * 窓は頁ごとに読み直すので、会話の `messages` / `startedAt` / `preview` はその窓の中で数えた値。
 * 継続点が指す発言が日誌に実在しない・人間との往復でないときは `InvalidConversationCursorError`。
 */
export async function readConversationPage(
  journal: Pick<JournalStore, 'list' | 'listPage' | 'get'>,
  options: {
    limit: number;
    scan: number;
    cursor?: ConversationCursor;
    readView?: ConversationReadView;
    since?: string;
    until?: string;
  },
): Promise<ConversationPage> {
  const { limit, scan, cursor, readView, since, until } = options;
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
    const newer = await conversationIdsNewerThan(journal, cursor, until);
    if (anchor.conversationId !== undefined) newer.add(anchor.conversationId);
    exclude = newer;
  }

  const entries = await readConversationWindow(journal, {
    scan,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
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
    const lastRead = entries[entries.length - 1];
    if (lastRead !== undefined) next = { id: lastRead.id, at: lastRead.at };
  }
  return {
    conversations,
    scanned: entries.length,
    reachedStart: reached,
    hiddenByLimit,
    next,
    positions: headOf,
  };
}
