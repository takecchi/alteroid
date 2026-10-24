import { noteDroppedRecord } from './dropped-record.js';
import { removeInboxEventsAndStopDelivery, type InboxDeliveryStopper } from './inbox-backlog.js';
import type { JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';

// 退避済み生ログの本文と受信箱の合図を消す口の「日誌が先」の順序（`removeScheduleJournalFirst` と同じ考え方）。
// 消す対象（id・理由・override）は消す前に決まるので先に書く。書けなければ消さない。
// 消した後でないと分からない値（バイト数・`already` か）は2行目として best-effort で足し、消せなかった分は打ち消しの行を足す。
// 先に消して後で書く順にしない: 日誌が落ちると、何を・誰が・なぜ消したかがどこにも残らない窓ができる（戻らない削除・配達の停止）。

type ArchiveRemoval = Awaited<ReturnType<Stores['archive']['remove']>>;

export type JournalFirstArchiveRemoveResult =
  | { readonly kind: 'removed'; readonly bytes: number }
  | { readonly kind: 'already'; readonly bytes: number; readonly removedAt: string }
  /** 消す前に書いた行は打ち消してある。 */
  | { readonly kind: 'missing' }
  /** 日誌に書けなかったので消していない。`entry` は書けなかった行。 */
  | {
      readonly kind: 'journal-failed';
      readonly error: unknown;
      readonly entry: JournalEntryInput;
    };

/**
 * 本文を1件消す（tombstone）。先の行を書いてから消し、消した後でないと分からないバイト数・`already` は `buildAfterEntry` の2行目で足す。
 *
 * 行を作るのは try の外: 作る側の例外を「日誌に書けなかった」と取り違えない。
 * `remove` が投げたら、消えたかどうかは分からないので打ち消しではなく「結果が確かめられていない」行を足して投げ直す。
 */
export async function removeArchiveJournalFirst(
  stores: Pick<Stores, 'archive' | 'journal'>,
  id: string,
  options: {
    readonly buildEntry: () => JournalEntryInput;
    readonly buildAfterEntry: (
      result: Extract<ArchiveRemoval, { kind: 'removed' | 'already' }>,
    ) => JournalEntryInput;
  },
): Promise<JournalFirstArchiveRemoveResult> {
  const entry = options.buildEntry();
  try {
    await stores.journal.append(entry);
  } catch (error) {
    return { kind: 'journal-failed', error, entry };
  }

  let result: ArchiveRemoval;
  try {
    result = await stores.archive.remove(id);
  } catch (error) {
    await appendBestEffort(
      stores,
      {
        type: 'decision',
        decision:
          `直前の退避済み生ログの本文を消す行（${id}）の結果は確かめられていない` +
          '（消す操作が失敗した。消えているかは archive の一覧で確かめること）',
        grounds: `${id} の本文削除。日誌を先に書いたが、消す操作が例外で終わったため`,
      },
      '退避済み生ログの削除失敗の補いの日誌',
      `id=${id}`,
    );
    throw error;
  }
  if (result.kind === 'missing') {
    await appendBestEffort(
      stores,
      {
        type: 'decision',
        decision: `直前の退避済み生ログの本文を消す行は効いていない（消していない）: ${id}`,
        grounds: `${id} の本文削除。日誌を先に書いたが、その id の退避が無かったため打ち消す`,
      },
      '退避済み生ログの削除の打ち消しの日誌',
      `id=${id}`,
    );
    return { kind: 'missing' };
  }
  await appendBestEffort(
    stores,
    options.buildAfterEntry(result),
    '退避済み生ログの削除結果の日誌',
    `id=${id}`,
  );
  return result.kind === 'already'
    ? { kind: 'already', bytes: result.bytes, removedAt: result.removedAt }
    : { kind: 'removed', bytes: result.bytes };
}

export type JournalFirstArchiveChunkResult =
  | {
      readonly kind: 'done';
      /** この呼びが実際に消した id。 */
      readonly removedIds: string[];
      readonly removedBytes: number;
      /** 先の行に書いたが、他経路が先に消していた（`missing`・`already`）id。打ち消してある。 */
      readonly racedIds: string[];
    }
  | {
      readonly kind: 'journal-failed';
      readonly error: unknown;
      readonly entry: JournalEntryInput;
    };

/**
 * 塊の先の行（消す id を全部並べる）を書いてから、1件ずつ消す（一括 UPDATE にしない: 1行1トランザクション・冪等・再開可能）。
 * 他経路が先に消していた id は、この呼びが消したことにしない（先の行には書いたので、打ち消しの行を足す）。
 */
export async function removeArchiveChunkJournalFirst(
  stores: Pick<Stores, 'archive' | 'journal'>,
  ids: readonly string[],
  buildEntry: () => JournalEntryInput,
): Promise<JournalFirstArchiveChunkResult> {
  const entry = buildEntry();
  try {
    await stores.journal.append(entry);
  } catch (error) {
    return { kind: 'journal-failed', error, entry };
  }

  const removedIds: string[] = [];
  const racedIds: string[] = [];
  let removedBytes = 0;
  try {
    for (const id of ids) {
      const result = await stores.archive.remove(id);
      if (result.kind === 'removed') {
        removedIds.push(id);
        removedBytes += result.bytes;
      } else {
        racedIds.push(id);
      }
    }
  } catch (error) {
    await retractUnconfirmed(stores, '退避済み生ログ', ids, removedIds);
    throw error;
  }
  if (racedIds.length > 0) {
    await appendBestEffort(
      stores,
      retractionEntry(
        '退避済み生ログの本文を消す行のうち、次の id は消していない（他経路が先に消していた）',
        racedIds,
      ),
      '退避済み生ログの塊の打ち消しの日誌',
      `raced=${racedIds.length}`,
    );
  }
  return { kind: 'done', removedIds, removedBytes, racedIds };
}

export type JournalFirstInboxChunkResult =
  | {
      readonly kind: 'done';
      readonly removedIds: string[];
      readonly droppedFromDelivery: number;
      /** 先の行に書いたが消えなかった id（他経路が先に消していた）。打ち消してある。 */
      readonly racedIds: string[];
    }
  | {
      readonly kind: 'journal-failed';
      readonly error: unknown;
      readonly entry: JournalEntryInput;
    };

/**
 * 受信箱の塊の先の行を書いてから、器から消して配達も止める（`removeInboxEventsAndStopDelivery`）。
 * 消えなかった id には打ち消しの行を足す。
 */
export async function removeInboxChunkJournalFirst(
  stores: Pick<Stores, 'inbox' | 'journal'>,
  delivery: InboxDeliveryStopper,
  ids: readonly string[],
  buildEntry: () => JournalEntryInput,
): Promise<JournalFirstInboxChunkResult> {
  const entry = buildEntry();
  try {
    await stores.journal.append(entry);
  } catch (error) {
    return { kind: 'journal-failed', error, entry };
  }

  let outcome: Awaited<ReturnType<typeof removeInboxEventsAndStopDelivery>>;
  try {
    outcome = await removeInboxEventsAndStopDelivery(stores.inbox, delivery, ids);
  } catch (error) {
    await retractUnconfirmed(stores, '受信箱の合図', ids, []);
    throw error;
  }
  const removed = new Set(outcome.removedIds);
  const racedIds = ids.filter((id) => !removed.has(id));
  if (racedIds.length > 0) {
    await appendBestEffort(
      stores,
      retractionEntry(
        '受信箱の合図を消す行のうち、次の id は消していない（他経路が先に消していた）',
        racedIds,
      ),
      '受信箱の塊の打ち消しの日誌',
      `raced=${racedIds.length}`,
    );
  }
  return {
    kind: 'done',
    removedIds: outcome.removedIds,
    droppedFromDelivery: outcome.droppedFromDelivery,
    racedIds,
  };
}

function retractionEntry(what: string, ids: readonly string[]): JournalEntryInput {
  return {
    type: 'decision',
    decision: `直前の行を一部打ち消す。${what}: ${ids.join(' ')}`,
    grounds: '日誌を先に書いたが、その id を消す操作は実行されなかったため打ち消す',
  };
}

// 例外で終わった塊は、どこまで消えたかが分からない: 打ち消しとは言わず「確かめられていない」と書く
async function retractUnconfirmed(
  stores: Pick<Stores, 'journal'>,
  what: string,
  ids: readonly string[],
  knownRemoved: readonly string[],
): Promise<void> {
  const known = new Set(knownRemoved);
  const unknown = ids.filter((id) => !known.has(id));
  await appendBestEffort(
    stores,
    {
      type: 'decision',
      decision:
        `直前の${what}を消す行のうち、次の id の結果は確かめられていない` +
        `（消す操作が失敗した。消えているか残っているかは確かめること）: ${unknown.join(' ')}`,
      grounds: '日誌を先に書いたが、消す操作が例外で終わったため',
    },
    `${what}の削除失敗の補いの日誌`,
    `unconfirmed=${unknown.length}`,
  );
}

// 書けなければ跡だけ残す: ここへ来る時点で状態は変わっていないか、変わった分の応答が既に決まっている
async function appendBestEffort(
  stores: Pick<Stores, 'journal'>,
  entry: JournalEntryInput,
  what: string,
  detail: string,
): Promise<void> {
  try {
    await stores.journal.append(entry);
  } catch (error) {
    noteDroppedRecord(what, detail, error);
  }
}
