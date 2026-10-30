import {
  wrapJournalStore,
  type JournalEntry,
  type JournalEntryInput,
  type JournalStore,
} from '@alteroid/core';

/** 墓標の後も残してよい行か: 墓標が隠した id でも、消した会話の発言でもない。 */
export function survivesDeletion(
  tombstone: Extract<JournalEntry, { type: 'conversation_deleted' }>,
): (entry: JournalEntry) => boolean {
  const hidden = new Set(tombstone.hiddenEntryIds ?? []);
  return (entry) =>
    !hidden.has(entry.id) &&
    !(entry.type === 'exchange' && entry.conversationId === tombstone.deletedConversationId);
}

/** 受け口がこれを呼ぶ: 追記の時点の見直し（下の `visible`）は、溜めている間に積まれた墓標を知らないため。 */
export function pruneQueuedForDeletion<T = JournalEntry>(
  queue: T[],
  tombstone: Extract<JournalEntry, { type: 'conversation_deleted' }>,
  entryOf: (item: T) => JournalEntry = (item) => item as unknown as JournalEntry,
): void {
  const survives = survivesDeletion(tombstone);
  const kept = queue.filter((item) => survives(entryOf(item)));
  queue.splice(0, queue.length, ...kept);
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

  // `clear()` も中身へそのまま渡し、購読者へ流さない: 日誌に載った出来事ではなく日誌そのものを空にする操作で、この層が中継するのは `append` の通知だけのため。
  const journal = wrapJournalStore(inner, {
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
  });

  return {
    journal,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
