import { noteDroppedRecord } from './dropped-record.js';
import type { JournalEntryInput, ScheduledRequest } from './schema.js';
import type { Stores } from './store.js';
import { ScheduleConflictError, UnreadableScheduleError } from './store.js';

/** 外す前に読んだ行。読めない形で入っていた行は `'unreadable'`（本文は持ち回らない）。 */
export type ScheduleRemoveTarget = ScheduledRequest | 'unreadable';

export type JournalFirstScheduleRemoveResult =
  | { readonly kind: 'removed'; readonly removed: ScheduleRemoveTarget }
  | { readonly kind: 'not-found' }
  /** 見た版と合わなかった（外していない）。`current` はいまの依頼（読めないときは `null`）。 */
  | { readonly kind: 'conflict'; readonly current: ScheduledRequest | null }
  /** 日誌に書けなかったので外していない（行は残ったまま）。`entry` は書けなかった行。 */
  | {
      readonly kind: 'journal-failed';
      readonly error: unknown;
      readonly entry: JournalEntryInput;
    };

/** 外した行が先の行に書いた中身と違っていたときに、補いの行へ書く説明。 */
function describeTarget(target: ScheduleRemoveTarget): string {
  return target === 'unreadable' ? '読めない形で入っていた依頼' : `依頼 ${target.request}`;
}

/**
 * 継続中の依頼を外す。外した行の本文（`request`）は行から消えるので、日誌へ残してから外す（正典の順序）。
 *
 * 先に外して後で日誌を書く順にしない: 日誌が落ちると、何が・誰によって外されたかが行にも日誌にも残らない窓ができる。
 * 日誌を書いた後に外せなかったら（その間に消えた・版が合わなくなった）、先の行を打ち消す行を足す（`reopenCommitmentJournalFirst` と同じ考え方）。
 *
 * `ScheduleStore` に「読むだけで3値を返す」口が無いので、`get` を試して `UnreadableScheduleError` を「読めない形で入っていた」と読む。
 * `get` の例外をそのまま上げない: 壊れた行を外す目的まで届かなくなる。
 *
 * `ifMatch` が読んだ版と既に合わないと分かれば、日誌を書かずに `conflict`（外さないので書く跡が無い）。
 * 読んだ後に変わった分は `removeIfPresent` の排他の中の比較が拾い、先の行を打ち消す。
 */
export async function removeScheduleJournalFirst(
  stores: Pick<Stores, 'schedules' | 'journal'>,
  kind: string,
  options: {
    readonly ifMatch?: string;
    readonly buildEntry: (before: ScheduleRemoveTarget) => JournalEntryInput;
  },
): Promise<JournalFirstScheduleRemoveResult> {
  let before: ScheduleRemoveTarget | null;
  try {
    before = await stores.schedules.get(kind);
  } catch (error) {
    if (!(error instanceof UnreadableScheduleError)) throw error;
    before = 'unreadable';
  }
  if (before === null) return { kind: 'not-found' };
  if (options.ifMatch !== undefined) {
    // 読めない行は見た版とは合いようがない（`removeIfPresent` と同じ）
    if (before === 'unreadable') return { kind: 'conflict', current: null };
    if (before.updatedAt !== options.ifMatch) return { kind: 'conflict', current: before };
  }

  // 行を作るのは try の外: 作る側の例外を「日誌に書けなかった」と取り違えない
  const entry = options.buildEntry(before);
  try {
    await stores.journal.append(entry);
  } catch (error) {
    return { kind: 'journal-failed', error, entry };
  }

  let removed: Awaited<ReturnType<Stores['schedules']['removeIfPresent']>>;
  try {
    removed = await stores.schedules.removeIfPresent(
      kind,
      options.ifMatch === undefined ? undefined : { ifMatch: options.ifMatch },
    );
  } catch (error) {
    if (!(error instanceof ScheduleConflictError)) throw error;
    await retractRemoveEntry(stores, kind, '外す直前に依頼が書き換えられていた（見た版と違う）');
    return { kind: 'conflict', current: error.current };
  }
  if (removed === null) {
    await retractRemoveEntry(stores, kind, '外す直前に依頼がほかで消えていた');
    return { kind: 'not-found' };
  }

  if (!sameTarget(removed, before)) {
    // 実際に消えた本文が日誌に無い状態を作らない
    await appendBestEffort(
      stores,
      {
        type: 'decision',
        decision:
          `定期の依頼の取り外し（${kind}）の間に依頼が書き換わっていた。` +
          `先の行に書いたものではなく、実際に外したのは次のとおり: ${describeTarget(removed)}`,
        grounds: `先の行の記録: ${describeTarget(before)}`,
      },
      '定期の依頼の取り外しで実際に外した行の補いの日誌',
      kind,
    );
  }
  return { kind: 'removed', removed };
}

function sameTarget(a: ScheduleRemoveTarget, b: ScheduleRemoveTarget): boolean {
  if (a === 'unreadable' || b === 'unreadable') return a === b;
  return a.request === b.request;
}

async function retractRemoveEntry(
  stores: Pick<Stores, 'journal'>,
  kind: string,
  why: string,
): Promise<void> {
  await appendBestEffort(
    stores,
    {
      type: 'decision',
      decision: `直前の定期の依頼を外す行は効いていない（外していない）。理由: ${why}`,
      grounds: `${kind} の取り外し。日誌を先に書いたが、依頼を外す操作が実行されなかったため打ち消す`,
    },
    '定期の依頼を外す日誌の打ち消し',
    kind,
  );
}

// 書けなければ跡だけ残して元の結果を返す: ここへ来る時点で状態は変わっていないか、変わった分の応答が既に決まっている
async function appendBestEffort(
  stores: Pick<Stores, 'journal'>,
  entry: JournalEntryInput,
  what: string,
  kind: string,
): Promise<void> {
  try {
    await stores.journal.append(entry);
  } catch (error) {
    noteDroppedRecord(what, `kind=${kind}`, error);
  }
}
