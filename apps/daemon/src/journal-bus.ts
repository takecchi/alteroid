import type {
  JournalEntry,
  JournalEntryInput,
  JournalPage,
  JournalQuery,
  JournalStore,
} from '@alteroid/core';

// 何を流すかを選り分ける表を持たせない: 見えない層を作らないための層で、そこで選別を始めると意味が消えるため。
export interface JournalBus {
  readonly journal: JournalStore;
  subscribe(listener: (entry: JournalEntry) => void): () => void;
}

export function createJournalBus(inner: JournalStore): JournalBus {
  const listeners = new Set<(entry: JournalEntry) => void>();

  const journal: JournalStore = {
    async append(entry: JournalEntryInput): Promise<JournalEntry> {
      const appended = await inner.append(entry);
      for (const listener of listeners) {
        try {
          listener(appended);
        } catch {
          // 1人の受け口が壊れても、他の受け口と記録を巻き込まない
        }
      }
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
