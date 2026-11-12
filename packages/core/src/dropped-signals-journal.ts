import {
  DROPPED_SIGNALS_JOURNAL_WORD,
  DROPPED_SIGNALS_RESTORE_WINDOW_MS,
  restoreDroppedSignals,
  SETTLED_SIGNALS_JOURNAL_WORD,
  type DroppedSignalDigest,
} from './dropped-signals.js';
import type { JournalStore } from './store.js';

/**
 * 日誌の「外れた」行と「届け終えた」行（どちらもクローン自身の跡。`with: 'self'`）を読み、再起動後に添え直す要旨を組む。
 * 人間との往復の窓ではないので、`readConversationWindow` を経由しない（`scripts/conversation-window-single-source.test.ts` の許可に入れてある）。
 * 読めなければ投げる: 呼び手が記録して空で進む。
 */
export async function readDroppedSignalsFromJournal(
  journal: Pick<JournalStore, 'list'>,
  now: number,
): Promise<{ digests: DroppedSignalDigest[]; overflowed: number }> {
  const since = new Date(now - DROPPED_SIGNALS_RESTORE_WINDOW_MS).toISOString();
  const read = (q: string) =>
    journal.list({ types: ['exchange'], with: ['self'], since, order: 'asc', q });
  const [dropped, settled] = await Promise.all([
    read(DROPPED_SIGNALS_JOURNAL_WORD),
    read(SETTLED_SIGNALS_JOURNAL_WORD),
  ]);
  return restoreDroppedSignals(dropped, settled);
}
