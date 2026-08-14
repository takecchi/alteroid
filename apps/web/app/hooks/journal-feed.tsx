/**
 * `useJournalLive()` の結果を context で下へ配る。
 *
 * SSE は `apps/web/app/routes/shell.tsx` の `AuthedShell` が1本だけ張る
 * （意図的な設計で、崩さない）。画面ごとに `useJournalLive()` を呼び直すと
 * 購読が増えてしまうので、子はこの context を読むだけの `useJournalFeed()`
 * を使う。**hook の中で `useJournalLive()` を呼んではいけない** — それは
 * `AuthedShell` の役目。
 */
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
