import {
  describeThreadpoolWait,
  measureThreadpoolWait,
  reasonOf,
  type Stores,
  type ThreadpoolWait,
} from '@alteroid/core';
import type { PgTimeoutEvent } from '@alteroid/storage-pg';

/** 日誌の `external_event` の source。`q` は `summary` に当たるので、引くときは文言（「以内に返らなかった」など）で引く。 */
export const PG_TIMEOUT_JOURNAL_SOURCE = 'pg-timeout';

export function describePgTimeout(event: PgTimeoutEvent): string {
  return event.kind === 'query'
    ? `PostgreSQL の問い合わせが ${String(event.timeoutMs)}ms 以内に返らなかったので、接続ごと切った（#4655）: ` +
        (event.sql ?? '（本文なし）')
    : `PostgreSQL へ ${String(event.timeoutMs)}ms 以内に繋げなかった（新しく繋ぐか、プールの空きを待つ間。#4655）`;
}

export interface PgTimeoutJournal {
  /** 日誌が使えるようになったら渡す。それまで（マイグレーションの間）の打ち切りは標準エラーにだけ出す。 */
  attach(journal: Pick<Stores['journal'], 'append'>): void;
  note(event: PgTimeoutEvent): void;
}

/**
 * PostgreSQL の期限切れを、標準エラーと日誌へ残す（#4655）。
 * 日誌も同じ PostgreSQL にあるので、書いている間に起きた打ち切りは数えるだけにして、次の1行に件数を添える:
 * 書きに行った日誌そのものが期限で切れると、その知らせがまた日誌を書きに行き、経路が死んでいる間じゅう連鎖するため。
 */
export function createPgTimeoutJournal(
  writeStderr: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
  /** 日誌の行に添えるスレッドの枠の待ちを測る口（#4890）。試験で差し替える。 */
  measureWait: () => Promise<ThreadpoolWait | undefined> = () => measureThreadpoolWait(),
): PgTimeoutJournal {
  let journal: Pick<Stores['journal'], 'append'> | undefined;
  let writing = false;
  let heldBack = 0;
  return {
    attach(target) {
      journal = target;
    },
    note(event) {
      const summary = describePgTimeout(event);
      writeStderr(`alteroidd: ${summary}\n`);
      if (journal === undefined) return;
      if (writing) {
        heldBack += 1;
        return;
      }
      writing = true;
      const extra = heldBack;
      heldBack = 0;
      // 枠の待ちは、日誌の行にだけ添える（標準エラーは即時に出す）: 接続が張れない原因が PostgreSQL の側か、
      // デーモン側のスレッドの枠（名前解決・ファイル）の詰まりかを、日誌だけで見分けるため（#4890）。
      // 測る間も `writing` は立てたままなので、測りが長引いても日誌を書く経路は1本のまま。
      const target = journal;
      void measureWait()
        .catch(() => undefined)
        .then((wait) =>
          target.append({
            type: 'external_event',
            source: PG_TIMEOUT_JOURNAL_SOURCE,
            summary:
              (extra > 0
                ? `${summary}（前の1行を書いている間に、ほかに ${String(extra)} 件打ち切った）`
                : summary) + `（${describeThreadpoolWait(wait)}）`,
          }),
        )
        .catch((error: unknown) => {
          writeStderr(
            `alteroidd: PostgreSQL の期限切れを日誌へ残せませんでした: ${reasonOf(error)}\n`,
          );
        })
        .finally(() => {
          writing = false;
        });
    },
  };
}
