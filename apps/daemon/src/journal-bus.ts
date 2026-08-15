import type { JournalEntry, JournalEntryInput, JournalQuery, JournalStore } from '@alteroid/core';

/**
 * 日誌の追記をそのまま購読できるようにする層。
 *
 * **なぜ要るのか。** 可観測性の3層は API から読めるが、読めるのは「聞きに行った
 * とき」だけである。だから画面は数秒ごとに聞き直すしかなく、承認待ちが出たことに
 * 気づけるのは次に人間が見たときになる。人間の不在で止まってよいのは承認待ちの
 * 仕事だけで（PRD「自律」）、**承認待ちが出たことに気づけない**のはそれとは別の
 * 話である。runner → デーモンには既に出来事の流れがあるのに、デーモン → 人間に
 * だけ無かった。
 *
 * ここに判断は無い。**日誌に載ったものがそのまま流れるだけ**である。何を流すかを
 * 選り分ける表を持たせないこと — 見えない層を作らないための層なのに、そこで
 * 選別を始めたら意味が消える。
 */
export interface JournalBus {
  /** クローンとデーモンが使う `JournalStore`。追記すると購読者へ流れる。 */
  readonly journal: JournalStore;
  /** 追記の購読。戻り値を呼ぶと解除。 */
  subscribe(listener: (entry: JournalEntry) => void): () => void;
}

export function createJournalBus(inner: JournalStore): JournalBus {
  const listeners = new Set<(entry: JournalEntry) => void>();

  const journal: JournalStore = {
    async append(entry: JournalEntryInput): Promise<JournalEntry> {
      const appended = await inner.append(entry);
      // 購読者の失敗で追記そのものを失敗させない。**記録が先、通知は後**である。
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
    get(id: string): Promise<JournalEntry | null> {
      return inner.get(id);
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
