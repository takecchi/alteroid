import { noteDroppedRecord } from './dropped-record.js';
import type { Commitment, CommitmentEditedBy, JournalEntryInput } from './schema.js';
import { CommitmentConflictError, commitmentVersionMatches } from './store.js';
import type { CommitmentEditResult, Stores } from './store.js';

export type JournalFirstEditResult =
  | { readonly kind: 'edited' }
  /** `editBody` が `not-edited`（閉じていた・無かった・通らなかった）。台帳は変わっていない。 */
  | { readonly kind: 'not-edited' }
  /** `ifMatch` が合わず書かなかった（読んだ版で既に合わないと分かった回は日誌も書いていない）。 */
  | { readonly kind: 'conflict'; readonly error: CommitmentConflictError }
  /** 日誌に書けなかったので書き直していない（行の本文は元のまま）。`entry` は書けなかった行。 */
  | {
      readonly kind: 'journal-failed';
      readonly error: unknown;
      readonly entry: JournalEntryInput;
    };

/**
 * 行の本文を書き直す。台帳の行は編集後の本文だけを持つので、編集前の本文は日誌にしか残らない。
 * だから日誌へ逐語で残してから書き直す（正典の順序）。
 *
 * 先に `editBody` して後で日誌を書く順にしない: 日誌が落ちると、上書きされた本文が行にも日誌にも残らない窓ができる。
 * 書いた後、`editBody` が排他の中で読んだ本文が先に読んだ本文と違えば、実際に上書きした本文を補いの行で残す
 * （{@link removeScheduleJournalFirst} と同じ考え方。#5251）。
 * 日誌を書いた後に台帳が割り込まれたら（`not-edited`・`CommitmentConflictError`・それ以外の例外）、先の行を打ち消す行を足す
 * （{@link reopenCommitmentJournalFirst} と同じ考え方。日誌に「直した」だけが残ると事実と食い違うため）。
 *
 * `existing` は呼び出し側が読んで `origin` を確かめた行。`entry` はその本文（編集前）と `body`（編集後）を逐語で含めること。
 * 行を作るのは呼び出し側で、この関数の try の外: 作る側の例外を「日誌に書けなかった」と取り違えない。
 */
export async function editCommitmentBodyJournalFirst(
  stores: Pick<Stores, 'commitments' | 'journal'>,
  existing: Commitment,
  body: string,
  by: CommitmentEditedBy,
  entry: JournalEntryInput,
  options?: { readonly ifMatch?: string },
): Promise<JournalFirstEditResult> {
  const id = existing.id;
  // 読んだ版で既に断ると分かる回は、日誌を書かずに今どおりの結果を返す（書いても打ち消すだけ）
  if (existing.closedAt !== undefined) return { kind: 'not-edited' };
  if (!commitmentVersionMatches(existing, options?.ifMatch)) {
    return { kind: 'conflict', error: new CommitmentConflictError(id, existing) };
  }

  try {
    await stores.journal.append(entry);
  } catch (error) {
    return { kind: 'journal-failed', error, entry };
  }

  let edited: CommitmentEditResult;
  try {
    edited = await stores.commitments.editBody(
      id,
      body,
      new Date().toISOString(),
      by,
      options?.ifMatch === undefined ? undefined : { ifMatch: options.ifMatch },
    );
  } catch (error) {
    await retractEditEntry(
      stores,
      id,
      error instanceof CommitmentConflictError
        ? '直す直前に版が変わっていた（読んだ後に別の書き手が直した、または消えた）'
        : '書き直しが例外で落ちた',
    );
    if (error instanceof CommitmentConflictError) return { kind: 'conflict', error };
    throw error;
  }
  if (edited.kind === 'not-edited') {
    await retractEditEntry(
      stores,
      id,
      '直す直前に行が閉じられた・消えた、または書き直しが通らなかった',
    );
    return { kind: 'not-edited' };
  }
  // 先の行に書いたのは読んだ時点の本文。`ifMatch` を付けない書き直しは、読んでから書くまでに別の書き手が本文を変えていても通るので、
  // 実際に上書きした本文（`editBody` の排他の中で読んだ行）が違えば、日誌に無い本文が消えないよう逐語で補う
  if (edited.before.body !== existing.body) {
    try {
      await stores.journal.append({
        type: 'decision',
        decision:
          `引き受けた仕事の本文の書き直し（${id}）の間に本文が書き換わっていた。` +
          `先の行に書いた編集前の本文ではなく、実際に上書きした本文は次のとおり: 「${edited.before.body}」`,
        grounds: `先の行の記録: 編集前「${existing.body}」→ 編集後「${body}」`,
      });
    } catch (error) {
      // 書き直しは済んでおり、呼び出し側の応答も決まっている: 跡だけ残す
      noteDroppedRecord('本文編集で実際に上書きした本文の補いの日誌', `id=${id}`, error);
    }
  }
  return { kind: 'edited' };
}

async function retractEditEntry(
  stores: Pick<Stores, 'journal'>,
  id: string,
  why: string,
): Promise<void> {
  try {
    await stores.journal.append({
      type: 'decision',
      decision: `直前の本文編集の行は効いていない（本文は直していない）。理由: ${why}`,
      grounds: `${id} の本文編集。日誌を先に書いたが、台帳の書き直しが実行されなかったため打ち消す`,
    });
  } catch (error) {
    // ここへ来る時点で台帳は変わっておらず、呼び出し側の応答も決まっている: 跡だけ残す
    noteDroppedRecord('本文編集の打ち消しの日誌', `id=${id}`, error);
  }
}
