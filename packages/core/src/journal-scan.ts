import type { JournalEntry } from './schema.js';
import type { JournalCursor, JournalQuery, JournalStore } from './store.js';

// 500 は実データの分布から決めた値ではなく、安全側に倒した経験則。大きすぎるとページ1枚のヒープが太り、小さすぎると往復が増える。
export const JOURNAL_SCAN_PAGE_SIZE = 500;

interface JournalScanOptions {
  pageSize?: number;
  // 省略時は無制限。印を見つけ次第 `onPage` が `false` を返して止める呼び出し以外は、必ずこの上限を渡すこと。
  maxScanned?: number;
}

interface JournalScanResult {
  scanned: number;
  // 境界の1件だけ安全側に倒す: ちょうど `maxScanned` 件目で日誌が尽きていても `true` を返す。続きの有無を確かめる追加の問い合わせをしないため。
  // `onPage` が自分で止めたときは `false` のまま: 打ち切りと早期終了を同じ値に潰さない。
  truncated: boolean;
}

type JournalScanPageHandler = (page: readonly JournalEntry[]) => void | boolean;

// 終端は `listPage()` の `next === null` だけで判断する。短いページも空ページも終端と読まない: store は `LIMIT` の後に壊れた行を捨てるので、ページが丸ごと壊れていれば空で返り、その先に古い行が残る。
export async function scanJournalPages(
  journal: Pick<JournalStore, 'listPage'>,
  query: Omit<JournalQuery, 'limit'>,
  onPage: JournalScanPageHandler,
  options: JournalScanOptions = {},
): Promise<JournalScanResult> {
  const pageSize = options.pageSize ?? JOURNAL_SCAN_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`pageSize は正の整数である必要がある: ${pageSize}`);
  }
  const { maxScanned } = options;
  const order = query.order ?? 'desc';

  // `after` の錨が見つからない例外は握り潰さない: 走査の途中で `journal.clear()` が挟まるとありうる。空へ倒さず呼び出し側へ伝える。
  let after = query.after;
  let scanned = 0;
  for (;;) {
    // `limit` は常に有限の正の整数にする: pg は `limit` 省略時に `Number.MAX_SAFE_INTEGER` を渡し、窓の大きい日にヒープへ全件を載せて落ちる。
    const budget = maxScanned === undefined ? pageSize : Math.min(pageSize, maxScanned - scanned);
    if (budget <= 0) return { scanned, truncated: true };

    const { entries: page, next } = await journal.listPage({
      ...query,
      order,
      after,
      limit: budget,
    });
    if (page.length > 0) {
      scanned += page.length;
      if (onPage(page) === false) return { scanned, truncated: false };
      if (maxScanned !== undefined && scanned >= maxScanned) return { scanned, truncated: true };
    }

    if (next === null) return { scanned, truncated: false };
    after = next;
  }
}

// 頁で読み切る（`list()` を `limit` なしで呼ばない）: 窓の `tool_use` は桁違いに多く、全件を1度にヒープへ載せると落ちるため。
// `listPage` の絞り（墓標・名指し・境界）をそのまま通す: 3実装の「窓の内の tool_use」の答えを `listPage` の1本に揃えるため。
// 本文を運ばずに数える口が要る器（pg）は、これを使わず SQL で数える
export async function countToolUsesByActorFromPages(
  journal: Pick<JournalStore, 'listPage'>,
  query: { since: string; until: string },
): Promise<{ actor: string; count: number }[]> {
  const counts = new Map<string, number>();
  await scanJournalPages(
    journal,
    { types: ['tool_use'], since: query.since, until: query.until },
    (page) => {
      for (const entry of page) {
        if (entry.type === 'tool_use') counts.set(entry.actor, (counts.get(entry.actor) ?? 0) + 1);
      }
    },
  );
  return [...counts].map(([actor, count]) => ({ actor, count }));
}

const WITHDRAWN_PAGE = 500;

// 取り下げの印の行（`with: 'self'`）は人間との往復の窓（`with: ['human']`）に入らないので、`with: ['self']` を別に読む。
// `since` 以降を古い順に頁で読み切る（途中で黙って打ち切らない）。
// 終端は `next === null` だけで決める: 短い頁・空の頁は読めない行を捨てた結果でありうるため。
// 本文を運ばずに印だけを引く口が要る器（pg）は、これを使わず SQL で引く
export async function withdrawnClientMessageIdsFromPages(
  journal: Pick<JournalStore, 'listPage'>,
  query: { since: string; conversationId?: string },
  pageSize: number = WITHDRAWN_PAGE,
): Promise<string[]> {
  const withdrawn = new Set<string>();
  let after: JournalCursor | undefined;
  for (;;) {
    const page = await journal.listPage({
      limit: pageSize,
      order: 'asc',
      types: ['exchange'],
      with: ['self'],
      since: query.since,
      ...(after === undefined ? {} : { after }),
    });
    for (const entry of page.entries) {
      if (
        entry.type === 'exchange' &&
        (query.conversationId === undefined || entry.conversationId === query.conversationId) &&
        entry.withdrawnClientMessageId !== undefined
      ) {
        withdrawn.add(entry.withdrawnClientMessageId);
      }
    }
    if (page.next === null) return [...withdrawn];
    if (after?.id === page.next.id) {
      throw new Error('取り下げの印を読む頁の継続点が進まない（ストアが `after` を守っていない）');
    }
    after = page.next;
  }
}

// 新しい順に人間との往復を最後まで頁で読み、`prefix` で始まる会話 id を現れた順に重複なく集めて、最大 `limit` 件を返す。
// 最後まで読む（`limit` 件で止めない）: 頁送りだった `lookupConversation` が、候補の上限を越えても読み続けていたのと同じ読み方にするため。
// 本文を運ばずに引く口が要る器（pg）は、これを使わず SQL で引く
export async function conversationIdsWithPrefixFromPages(
  journal: Pick<JournalStore, 'listPage'>,
  query: { prefix: string; limit: number },
): Promise<string[]> {
  const ids = new Set<string>();
  await scanJournalPages(journal, { types: ['exchange'], with: ['human'] }, (page) => {
    for (const entry of page) {
      if (entry.type !== 'exchange' || entry.conversationId === undefined) continue;
      if (entry.conversationId.startsWith(query.prefix)) ids.add(entry.conversationId);
    }
  });
  return [...ids].slice(0, query.limit);
}

// `listPage` の絞り（墓標・名指し・錨）をそのまま通す: 3実装の「錨より新しい人間との往復」の答えを `listPage` の1本に揃えるため。
// 錨が見つからない例外は `scanJournalPages` が握り潰さず伝える。本文を運ばずに引く口が要る器（pg）は、これを使わず SQL で引く
export async function conversationIdsAfterFromPages(
  journal: Pick<JournalStore, 'listPage'>,
  query: { after: JournalCursor; until?: string },
): Promise<string[]> {
  const ids = new Set<string>();
  await scanJournalPages(
    journal,
    {
      types: ['exchange'],
      with: ['human'],
      order: 'asc',
      after: query.after,
      ...(query.until === undefined ? {} : { until: query.until }),
    },
    (page) => {
      for (const entry of page) {
        if (entry.type === 'exchange' && entry.conversationId !== undefined) {
          ids.add(entry.conversationId);
        }
      }
    },
  );
  return [...ids];
}
