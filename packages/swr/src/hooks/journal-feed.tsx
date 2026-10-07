// この hook の中で `useJournalLive()` を呼ばない: 画面ごとに呼ぶと SSE の購読が増える。張るのは `AuthedShell` の1本だけ
import { createContext, useContext, type ReactNode } from 'react';

import type { JournalLive } from './use-journal-live';

const JournalFeedContext = createContext<JournalLive | null>(null);

export function JournalFeedProvider({
  value,
  children,
}: {
  value: JournalLive;
  children: ReactNode;
}) {
  return <JournalFeedContext.Provider value={value}>{children}</JournalFeedContext.Provider>;
}

export function useJournalFeed(): JournalLive {
  const value = useContext(JournalFeedContext);
  if (value === null) throw new Error('useJournalFeed は JournalFeedProvider の中でだけ使える');
  return value;
}
