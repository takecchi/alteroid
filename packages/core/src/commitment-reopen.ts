import { noteDroppedRecord } from './dropped-record.js';
import type { Commitment, JournalEntryInput } from './schema.js';
import { UnreadableCommitmentError } from './store.js';
import type { Stores } from './store.js';

export type JournalFirstReopenResult =
  | { readonly kind: 'reopened'; readonly before: Commitment }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-closed' }
  | { readonly kind: 'duplicate-open'; readonly openId: string }
  | { readonly kind: 'unreadable'; readonly error: UnreadableCommitmentError }
  /** 日誌に書けなかったので開き直していない（行は閉じたまま）。`entry` は書けなかった行。 */
  | {
      readonly kind: 'journal-failed';
      readonly error: unknown;
      readonly entry: JournalEntryInput;
    };

type ClosedRecord = Pick<Commitment, 'closedAt' | 'closedBy' | 'closedReason'>;

/** 閉じた記録を逐語で書く。HTTP と道具の日誌の行が同じ書式を使うので、ここに1本だけ置く。 */
export function describeClosedRecord(record: ClosedRecord): string {
  return (
    `closedAt=${record.closedAt ?? '記録なし'}・closedBy=${record.closedBy ?? '記録なし'}` +
    `・closedReason=${record.closedReason ?? '記録なし'}`
  );
}

function sameClosedRecord(a: ClosedRecord, b: ClosedRecord): boolean {
  return (
    a.closedAt === b.closedAt && a.closedBy === b.closedBy && a.closedReason === b.closedReason
  );
}

/**
 * 閉じた行を開き直す。閉じた記録は行から消えるので、日誌へ逐語で残してから行から外す（正典の順序）。
 *
 * 先に `reopen` して後で日誌を書く順にしない: 日誌が落ちると、閉じた時刻・主体・理由が行にも日誌にも残らない窓ができる。
 * 日誌を書いた後に台帳が割り込まれたら（`reopen` の結果が `reopened` でない）、先の行を打ち消す行を足す
 * （`PUT /memory/:slug` の `write_failed` と同じ考え方。日誌に「開き直した」だけが残ると事実と食い違うため）。
 *
 * `duplicate-open` はここでは先に判定しない: 判定に台帳の全件読みが要り、`reopen` の排他区間の中でしか確定しない。
 * 先読みしても割り込まれうるので、結局打ち消しが要る。
 *
 * `buildEntry` は読んだ行（`before`）を受け取って日誌の行を作る。閉じた記録は {@link describeClosedRecord} で逐語に含めること。
 */
export async function reopenCommitmentJournalFirst(
  stores: Pick<Stores, 'commitments' | 'journal'>,
  id: string,
  buildEntry: (before: Commitment) => JournalEntryInput,
): Promise<JournalFirstReopenResult> {
  let read: Commitment | null;
  try {
    read = await stores.commitments.get(id);
  } catch (error) {
    if (!(error instanceof UnreadableCommitmentError)) throw error;
    return { kind: 'unreadable', error };
  }
  if (read === null) return { kind: 'not-found' };
  if (read.closedAt === undefined) return { kind: 'not-closed' };

  // 行を作るのは try の外: 作る側の例外を「日誌に書けなかった」と取り違えない
  const entry = buildEntry(read);
  try {
    await stores.journal.append(entry);
  } catch (error) {
    return { kind: 'journal-failed', error, entry };
  }

  let result;
  try {
    result = await stores.commitments.reopen(id);
  } catch (error) {
    if (!(error instanceof UnreadableCommitmentError)) throw error;
    await retractReopenEntry(stores, id, '開き直す直前に行が読めない形になった');
    return { kind: 'unreadable', error };
  }

  if (result.kind !== 'reopened') {
    await retractReopenEntry(stores, id, describeInterruption(result));
    return result;
  }

  if (!sameClosedRecord(result.before, read)) {
    // 行から実際に消えた記録が日誌に無い状態を作らない
    await appendBestEffort(
      stores,
      {
        type: 'decision',
        decision:
          `開き直し（${id}）の間に閉じ直されていた。直前の開き直しの行に書いた記録ではなく、` +
          `実際に行から外した記録は次のとおり: ${describeClosedRecord(result.before)}`,
        grounds: `先の行の記録: ${describeClosedRecord(read)}`,
      },
      '開き直しで実際に外した記録の補いの日誌',
      id,
    );
  }
  return result;
}

function describeInterruption(
  result: Exclude<Awaited<ReturnType<Stores['commitments']['reopen']>>, { kind: 'reopened' }>,
): string {
  switch (result.kind) {
    case 'not-found':
      return '開き直す直前に行が台帳から消えていた';
    case 'not-closed':
      return '開き直す直前に別の手で開き直されていた（閉じていなかった）';
    case 'duplicate-open':
      return `同じ担当・同じ本文の未了の行 ${result.openId} が在って重複になる`;
  }
}

async function retractReopenEntry(
  stores: Pick<Stores, 'journal'>,
  id: string,
  why: string,
): Promise<void> {
  await appendBestEffort(
    stores,
    {
      type: 'decision',
      decision: `直前の開き直しの行は効いていない（開き直していない）。理由: ${why}`,
      grounds: `${id} の開き直し。日誌を先に書いたが、台帳の開き直しが実行されなかったため打ち消す`,
    },
    '開き直しの打ち消しの日誌',
    id,
  );
}

// 書けなければ跡だけ残して元の結果を返す: ここへ来る時点で台帳は変わっていないか、変わった分の応答が既に決まっている
async function appendBestEffort(
  stores: Pick<Stores, 'journal'>,
  entry: JournalEntryInput,
  what: string,
  id: string,
): Promise<void> {
  try {
    await stores.journal.append(entry);
  } catch (error) {
    noteDroppedRecord(what, `id=${id}`, error);
  }
}
