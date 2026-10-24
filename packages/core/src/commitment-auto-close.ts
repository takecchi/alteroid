import { noteDroppedRecord } from './dropped-record.js';
import type { JournalEntryInput } from './schema.js';
import { UnreadableCommitmentError } from './store.js';
import type { Stores } from './store.js';

export type JournalFirstCloseResult =
  | { readonly kind: 'closed' }
  /** 無い、または既に閉じている。日誌は書いていない。 */
  | { readonly kind: 'not-open' }
  /** 行が読めない形で入っている。閉じていない（残す側）。 */
  | { readonly kind: 'unreadable'; readonly error: UnreadableCommitmentError }
  /** 日誌に書けなかったので閉じていない（行は未了のまま）。 */
  | { readonly kind: 'journal-failed'; readonly error: unknown }
  /** 日誌を書いた後に、別の手で閉じられていた。打ち消しの行を足してある。 */
  | { readonly kind: 'interrupted' };

/**
 * 器が台帳の行を自動で閉じる。日誌へ先に残してから閉じる（正典「閉じた理由は台帳と日誌の両方に残す」「失敗は残る側へ倒す」）。
 *
 * 先に `close` して後で日誌を書く順にしない: 日誌が落ちると、器が閉じた事実が `closedReason` にしか残らず、
 * 閉じた行が保持上限で物理削除されると、それも消える。書けなければ閉じない（`commitment-reopen.ts` と同じ順序）。
 * 日誌を書いた後に台帳が割り込まれたら（`close` が `false`）、先の行を打ち消す行を足す。
 */
export async function closeCommitmentJournalFirst(
  stores: Pick<Stores, 'commitments' | 'journal'>,
  id: string,
  input: { readonly reason: string; readonly entry: JournalEntryInput },
): Promise<JournalFirstCloseResult> {
  try {
    const read = await stores.commitments.get(id);
    if (read === null || read.closedAt !== undefined) return { kind: 'not-open' };
  } catch (error) {
    if (!(error instanceof UnreadableCommitmentError)) throw error;
    return { kind: 'unreadable', error };
  }

  try {
    await stores.journal.append(input.entry);
  } catch (error) {
    return { kind: 'journal-failed', error };
  }

  let closed: boolean;
  try {
    closed = await stores.commitments.close(id, new Date().toISOString(), input.reason, 'daemon');
  } catch (error) {
    await retractCloseEntry(
      stores,
      id,
      '閉じる直前に行が読めない形になった、または台帳が閉じられなかった',
    );
    throw error;
  }
  if (!closed) {
    await retractCloseEntry(
      stores,
      id,
      '閉じる直前に別の手で閉じられていた（または台帳から消えていた）',
    );
    return { kind: 'interrupted' };
  }
  return { kind: 'closed' };
}

async function retractCloseEntry(
  stores: Pick<Stores, 'journal'>,
  id: string,
  why: string,
): Promise<void> {
  try {
    await stores.journal.append({
      type: 'decision',
      decision: `直前の自動クローズの行は効いていない（閉じていない）。理由: ${why}`,
      grounds: `${id} の自動クローズ。日誌を先に書いたが、台帳の close が実行されなかったため打ち消す`,
    });
  } catch (error) {
    noteDroppedRecord('自動クローズの打ち消しの日誌', `id=${id}`, error);
  }
}
