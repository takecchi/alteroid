import { JournalAnchorNotFoundError } from './store.js';
import type { JournalEntry } from './schema.js';
import type { JournalPage, JournalQuery, JournalStore } from './store.js';

// createMemoryStores を使わない: million 行を実際に push することになり、歯の準備そのものがテストプロセスのヒープを食うため
export interface SyntheticJournalStoreOptions {
  total: number;
  entryAt: (index: number) => Omit<JournalEntry, 'id' | 'at'>;
  baseTimeMs?: number;
  unreadable?: (index: number) => boolean;
}

export interface SyntheticJournalStore {
  store: JournalStore;
  calls: JournalQuery[];
  totalReturned: number;
  entryOf: (index: number) => JournalEntry;
}

const ID_PREFIX = 'synthetic-';
const ID_DIGITS = 12;

export function createSyntheticJournalStore(
  options: SyntheticJournalStoreOptions,
): SyntheticJournalStore {
  const { total, entryAt } = options;
  const baseTimeMs = options.baseTimeMs ?? Date.parse('2026-01-01T00:00:00.000Z');
  const calls: JournalQuery[] = [];
  let totalReturned = 0;

  const idOf = (index: number): string => `${ID_PREFIX}${String(index).padStart(ID_DIGITS, '0')}`;
  const indexOfId = (id: string): number | undefined => {
    if (!id.startsWith(ID_PREFIX)) return undefined;
    const n = Number(id.slice(ID_PREFIX.length));
    return Number.isInteger(n) ? n : undefined;
  };
  const entryOf = (index: number): JournalEntry =>
    ({
      ...entryAt(index),
      id: idOf(index),
      at: new Date(baseTimeMs - index).toISOString(),
    }) as JournalEntry;

  function* indices(order: 'asc' | 'desc', anchorIndex: number | undefined): Generator<number> {
    if (order === 'desc') {
      const start = anchorIndex === undefined ? 0 : anchorIndex + 1;
      for (let i = start; i < total; i++) yield i;
    } else {
      const start = anchorIndex === undefined ? total - 1 : anchorIndex - 1;
      for (let i = start; i >= 0; i--) yield i;
    }
  }

  const readPage = (query: JournalQuery): JournalPage => {
    if (query.limit === undefined || !Number.isFinite(query.limit) || query.limit <= 0) {
      // 本番の穴（`limit ?? Number.MAX_SAFE_INTEGER`）をこの偽物で再現させない: ここへ来た時点で呼び出し側の設計が壊れているため
      throw new Error(
        `この偽ストアは有限の正の limit を要求する（渡ってきた値: ${String(query.limit)}）`,
      );
    }

    let anchorIndex: number | undefined;
    if (query.after !== undefined) {
      const after = query.after;
      const candidate = indexOfId(after.id);
      const anchorEntry = candidate === undefined ? undefined : entryOf(candidate);
      if (
        candidate === undefined ||
        candidate < 0 ||
        candidate >= total ||
        anchorEntry === undefined ||
        anchorEntry.at !== after.at
      ) {
        throw new JournalAnchorNotFoundError(
          `after で指定された行が見つからない: ${JSON.stringify(after)}`,
        );
      }
      anchorIndex = candidate;
    }

    const order = query.order ?? 'desc';
    const raw: number[] = [];
    for (const index of indices(order, anchorIndex)) {
      const entry = entryOf(index);
      if (query.since !== undefined && entry.at < query.since) continue;
      if (query.until !== undefined && entry.at > query.until) continue;
      if (query.types !== undefined && !query.types.includes(entry.type)) continue;
      if (query.with !== undefined) {
        if (entry.type !== 'exchange' || !query.with.includes(entry.with)) continue;
      }
      raw.push(index);
      if (raw.length > query.limit) break;
    }
    const pageRaw = raw.slice(0, query.limit);
    const lastRaw = pageRaw[pageRaw.length - 1];
    const entries = pageRaw
      .filter((index) => options.unreadable?.(index) !== true)
      .map((index) => entryOf(index));
    totalReturned += entries.length;
    const next =
      raw.length > query.limit && lastRaw !== undefined
        ? { id: idOf(lastRaw), at: entryOf(lastRaw).at }
        : null;
    return { entries, next };
  };

  const list = async (query: JournalQuery = {}): Promise<JournalEntry[]> => {
    calls.push(query);
    return readPage(query).entries;
  };

  const listPage = async (query: JournalQuery = {}): Promise<JournalPage> => {
    calls.push(query);
    return readPage(query);
  };

  // `unreadable` を見ない: pg の地平は読めない行も数えるため
  const oldestAt = async (): Promise<string | null> => (total > 0 ? entryOf(total - 1).at : null);

  const notImplemented = (name: string) => (): never => {
    throw new Error(
      `この偽ストアの ${name}() はスタブである（呼ばれない前提）。呼ばれたのなら、` +
        'テスト対象が journal.list() 以外を呼んでいる——歯の設計を見直すこと。',
    );
  };

  return {
    store: {
      list,
      listPage,
      append: notImplemented('append'),
      get: notImplemented('get'),
      oldestAt,
      clear: notImplemented('clear'),
    },
    calls,
    get totalReturned() {
      return totalReturned;
    },
    entryOf,
  };
}
