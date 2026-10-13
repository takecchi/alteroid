import type {
  JournalEntry,
  JournalEntryInput,
  JournalPage,
  JournalQuery,
  JournalStore,
} from '@alteroid/core';

/** 受け口がこれを呼ぶ: 追記の時点の見直し（下の `visible`）は、溜めている間に積まれた墓標を知らないため。 */
export function pruneQueuedForDeletion<T = JournalEntry>(
  queue: T[],
  tombstone: Extract<JournalEntry, { type: 'conversation_deleted' }>,
  entryOf: (item: T) => JournalEntry = (item) => item as unknown as JournalEntry,
): void {
  const hidden = new Set(tombstone.hiddenEntryIds ?? []);
  const kept = queue.filter((item) => {
    const entry = entryOf(item);
    return (
      !hidden.has(entry.id) &&
      !(entry.type === 'exchange' && entry.conversationId === tombstone.deletedConversationId)
    );
  });
  queue.splice(0, queue.length, ...kept);
}

/** `/journal/stream` の購読者1本あたりの待ち行列の上限。件数と、書き出す JSON の字数の両方で締める。 */
export const JOURNAL_STREAM_QUEUE_MAX_ENTRIES = 5_000;
export const JOURNAL_STREAM_QUEUE_MAX_CHARS = 16_000_000;

export interface QueuedJournalEntry {
  readonly entry: JournalEntry;
  /** 書き出す `data`。積むときに1回だけ直列化し、字数の勘定と書き出しで使い回す。 */
  readonly data: string;
}

/**
 * `/journal/stream` の購読者1本ぶんの待ち行列（#4617）。
 * 上限を超えたら溜めた分を捨てて「溢れた」に落ち、以後は何も積まない: 読まない受け手のために日誌の全行をメモリに溜め続けないため。
 * 溢れた購読は閉じる側（`app.ts`）が切る。受け手は張り直した `open` で表示中のデータを取り直すので、抜けた分はそこで戻る。
 */
export class JournalStreamQueue {
  readonly #maxEntries: number;
  readonly #maxChars: number;
  #items: QueuedJournalEntry[] = [];
  #chars = 0;
  #overflow: { entries: number; chars: number } | undefined;

  constructor(limits: { maxEntries?: number; maxChars?: number } = {}) {
    this.#maxEntries = limits.maxEntries ?? JOURNAL_STREAM_QUEUE_MAX_ENTRIES;
    this.#maxChars = limits.maxChars ?? JOURNAL_STREAM_QUEUE_MAX_CHARS;
  }

  /** 溢れたときの件数と字数（溢れた1件を含む）。溢れていなければ `undefined`。 */
  get overflow(): { entries: number; chars: number } | undefined {
    return this.#overflow;
  }

  push(entry: JournalEntry): void {
    if (this.#overflow !== undefined) return;
    const data = JSON.stringify(entry);
    this.#items.push({ entry, data });
    this.#chars += data.length;
    if (this.#items.length > this.#maxEntries || this.#chars > this.#maxChars) {
      this.#overflow = { entries: this.#items.length, chars: this.#chars };
      this.#items = [];
      this.#chars = 0;
    }
  }

  shift(): QueuedJournalEntry | undefined {
    const item = this.#items.shift();
    if (item !== undefined) this.#chars -= item.data.length;
    return item;
  }

  pruneForDeletion(tombstone: Extract<JournalEntry, { type: 'conversation_deleted' }>): void {
    pruneQueuedForDeletion(this.#items, tombstone, (item) => item.entry);
    this.#chars = this.#items.reduce((sum, item) => sum + item.data.length, 0);
  }
}

// 何を流すかを選り分ける表を持たせない: 見えない層を作らないための層で、そこで選別を始めると意味が消えるため。
export interface JournalBus {
  readonly journal: JournalStore;
  subscribe(listener: (entry: JournalEntry) => void): () => void;
}

export function createJournalBus(inner: JournalStore): JournalBus {
  const listeners = new Set<(entry: JournalEntry) => void>();
  // 通知を1列に並べる: 下の引き直しで await を挟むので、並べないと追記の順と流れる順がずれるため
  let notified: Promise<void> = Promise.resolve();

  /**
   * 削除した会話の発言は、追記されても流さない。どの会話を消したかはストアだけが知っている
   * （墓標の行）ので、ここに表を写さず、会話 id を持つ行だけストアへ引き直し、外れていれば流さない。
   */
  async function visible(appended: JournalEntry): Promise<boolean> {
    if (appended.type !== 'exchange' || appended.conversationId === undefined) return true;
    return (await inner.get(appended.id)) !== null;
  }

  const journal: JournalStore = {
    async append(entry: JournalEntryInput): Promise<JournalEntry> {
      const appended = await inner.append(entry);
      if (listeners.size === 0) return appended;
      const step = notified.then(async () => {
        if (!(await visible(appended).catch(() => false))) return;
        for (const listener of listeners) {
          try {
            listener(appended);
          } catch {
            // 1人の受け口が壊れても、他の受け口と記録を巻き込まない
          }
        }
      });
      notified = step;
      await step;
      return appended;
    },
    list(query?: JournalQuery): Promise<JournalEntry[]> {
      return inner.list(query);
    },
    listPage(query?: JournalQuery): Promise<JournalPage> {
      return inner.listPage(query);
    },
    get(id: string): Promise<JournalEntry | null> {
      return inner.get(id);
    },
    oldestAt(): Promise<string | null> {
      return inner.oldestAt();
    },
    // `clear()` は購読者へ流さない: 日誌に載った出来事ではなく日誌そのものを空にする操作で、この層が中継するのは `append` の通知だけのため。
    clear(): Promise<number> {
      return inner.clear();
    },
  };

  return {
    journal,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
