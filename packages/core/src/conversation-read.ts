import { readConversationWindow } from './conversation.js';
import { compareIsoInstant } from './iso-instant.js';
import type { ConversationReadStore, JournalStore } from './store.js';

export interface ConversationReadPosition {
  readThrough: string;
  updatedAt: string;
}

// 「無い」と「読めない」を分ける: unreadable を none へ潰すと、全件が黙って未読へ戻ったことを誰も説明できないため
export type ConversationReadRead =
  | {
      state: 'ok';
      baseline: string | null;
      positions: Record<string, ConversationReadPosition>;
    }
  | { state: 'unreadable'; reason: string };

export interface ConversationOutboundIndex {
  watermark: string | null;
  lastOutbound: Record<string, string>;
}

export type ConversationOutboundIndexRead =
  ({ state: 'ok' } & ConversationOutboundIndex) | { state: 'unreadable'; reason: string };

export type ConversationBaselineResult =
  { state: 'ok'; baseline: string } | { state: 'unreadable'; reason: string };

// unreadable のとき全件を未読として数える: 知らせすぎる側へ倒す。知らせ損ねるほうが取り返しがつかないため
export interface ConversationReadView {
  baseline: string | null;
  positions: Readonly<Record<string, ConversationReadPosition>>;
  unreadable?: string;
}

export async function loadConversationReadView(
  store: ConversationReadStore,
  now: string,
): Promise<ConversationReadView> {
  const ensured = await store.ensureBaseline(now);
  if (ensured.state === 'unreadable') {
    return { baseline: null, positions: {}, unreadable: ensured.reason };
  }
  const read = await store.read();
  if (read.state === 'unreadable') {
    return { baseline: null, positions: {}, unreadable: read.reason };
  }
  return { baseline: read.baseline ?? ensured.baseline, positions: read.positions };
}

interface UnreadConversationCount {
  count: number;
  capped: boolean;
  readStateUnreadable?: string;
}

const UNREAD_CONVERSATION_COUNT_CAP = 99;
const INDEX_CHUNK = 500;
const INDEX_MAX_CHUNKS = 40;
// 取り込み済みの印を「いま」より手前に置く: 書き込みの完了が at より遅れても取りこぼさないため
const WATERMARK_LAG_MS = 60_000;

function laterIso(a: string, b: string): string {
  return compareIsoInstant(a, b) >= 0 ? a : b;
}

// 日誌を広く遡らない: 索引の続きだけを読んで足し、日誌が育っても1回の費用を新しい分だけにするため
export async function countUnreadConversations(
  deps: {
    journal: Pick<JournalStore, 'list' | 'humanReplies'>;
    reads: ConversationReadStore;
    now: string;
  },
  options: { cap?: number; chunk?: number; maxChunks?: number } = {},
): Promise<UnreadConversationCount> {
  const cap = options.cap ?? UNREAD_CONVERSATION_COUNT_CAP;
  const chunk = options.chunk ?? INDEX_CHUNK;
  const maxChunks = options.maxChunks ?? INDEX_MAX_CHUNKS;
  const { journal, reads, now } = deps;

  const view = await loadConversationReadView(reads, now);
  if (view.unreadable !== undefined || view.baseline === null) {
    return { count: 0, capped: false, readStateUnreadable: view.unreadable ?? '基準時刻が無い' };
  }
  const before = await reads.readOutboundIndex();
  if (before.state === 'unreadable') {
    return { count: 0, capped: false, readStateUnreadable: before.reason };
  }

  const from =
    before.watermark === null ? view.baseline : laterIso(before.watermark, view.baseline);
  const found: Record<string, string> = {};
  const note = (conversationId: string, at: string) => {
    // NUL を含む会話 id を索引へ入れない: ストアが鍵の NUL を断り、1件の不正な id で毎回落ちると全会話の未読数が出なくなるため
    if (conversationId.includes('\u0000')) return;
    const known = found[conversationId];
    if (known === undefined || compareIsoInstant(at, known) > 0) found[conversationId] = at;
  };
  let lastAt: string | null = null;
  let complete = false;
  if (journal.humanReplies !== undefined) {
    // 人間への返答の会話 id と時刻だけを返す口を持つ器ではそちらを使う（#5140）: 下の頁送りは、印が無い・古いと人間との往復を本文ごと
    // 最大 40 チャンク（500 行ずつ）読み、1本目は `at >= 印` を索引の条件にできず印より前の往復を頭から読み捨てるので、本番で1回 9 秒・166 本かかった。
    // この口は器が覚えて新しい行だけ読み足すので、印からの返答を1回で全部取れる（取りこぼしが無いので `complete`）
    for (const reply of await journal.humanReplies()) {
      if (compareIsoInstant(reply.at, from) < 0) continue;
      note(reply.conversationId, reply.at);
    }
    complete = true;
  } else {
    // 古い順に印から前へ向かって読む: チャンクごとに確実に前進し、溜まった分が1回の上限の何倍あっても呼び出しを重ねれば追いつくため
    let after: { id: string; at: string } | undefined;
    for (let i = 0; i < maxChunks; i += 1) {
      const rows = await readConversationWindow(journal, {
        scan: chunk,
        since: from,
        order: 'asc',
        ...(after === undefined ? {} : { after }),
      });
      for (const row of rows) {
        if (
          row.type !== 'exchange' ||
          row.role !== 'outbound' ||
          row.conversationId === undefined
        ) {
          continue;
        }
        note(row.conversationId, row.at);
      }
      const last = rows[rows.length - 1];
      if (last !== undefined) {
        lastAt = last.at;
        after = { id: last.id, at: last.at };
      }
      if (rows.length < chunk) {
        complete = true;
        break;
      }
    }
  }
  const lagged = new Date(Date.parse(now) - WATERMARK_LAG_MS).toISOString();
  await reads.mergeOutboundIndex({
    watermark: complete ? laterIso(from, lagged) : lastAt,
    lastOutbound: found,
  });

  const index = await reads.readOutboundIndex();
  if (index.state === 'unreadable') {
    return { count: 0, capped: false, readStateUnreadable: index.reason };
  }
  let count = 0;
  for (const [conversationId, lastAt] of Object.entries(index.lastOutbound)) {
    const position = view.positions[conversationId]?.readThrough;
    const floor = position === undefined ? view.baseline : laterIso(position, view.baseline);
    if (compareIsoInstant(lastAt, floor) > 0) count += 1;
  }
  const over = count > cap;
  return { count: over ? cap : count, capped: over || !complete };
}
