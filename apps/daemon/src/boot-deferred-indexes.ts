import { BOOT_DEFERRED_INDEXES_EVENT_SOURCE, reasonOf, type Stores } from '@alteroid/core';
import type { DeferredIndexOutcome } from '@alteroid/storage-pg';

const STATE_LABELS = {
  valid: '有効（既に在った）',
  built: '作った',
  failed: '作れなかった',
} as const;

/** 索引ごとの結果を1行にする。作った・作れなかった索引は、かかった時間と理由も添える */
export function describeDeferredIndexes(outcomes: readonly DeferredIndexOutcome[]): string {
  const parts = outcomes.map((outcome) => {
    const seconds = `${(outcome.ms / 1000).toFixed(1)} 秒`;
    const detail =
      outcome.state === 'valid'
        ? ''
        : outcome.state === 'built'
          ? `（作り終えるまで ${seconds}。有効と確かめた）`
          : `（${seconds}。${outcome.reason ?? '理由は分からない'}）`;
    return `${outcome.index}=${STATE_LABELS[outcome.state]}${detail}`;
  });
  const failed = outcomes.filter((outcome) => outcome.state === 'failed').length;
  return (
    `起動の後に作る日誌の索引: ${parts.join('; ')}` +
    (failed === 0
      ? ''
      : `。${String(failed)} 本は索引なしで動いている（遅いだけで、答えは変わらない）`)
  );
}

export interface DeferredIndexesReporter {
  /** 日誌が使えるようになったら渡す。それより前に結果が来ていれば、渡したときに書く */
  attach(journal: Pick<Stores['journal'], 'append'>): void;
  note(outcomes: readonly DeferredIndexOutcome[]): void;
}

/**
 * 起動の後に作る索引の結果を、標準出力と日誌の両方に残す（起動時の器の実寸（`reportBootFootprint`）と同じ作法）。
 * 日誌に残す: 本番の DB を見ずに「索引が在って有効か」を確かめる手が、ほかに無いため（作れたときは何も出さない作りだった）。
 * 結果は日誌を渡す前に届きうる（索引が既に在れば、起動の直後に確かめ終わる）ので、渡すまで預かる。
 */
export function createDeferredIndexesReporter(
  writeLine: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
  writeError: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): DeferredIndexesReporter {
  let journal: Pick<Stores['journal'], 'append'> | undefined;
  let pending: string | undefined;
  const write = (target: Pick<Stores['journal'], 'append'>, summary: string) => {
    void target
      .append({ type: 'external_event', source: BOOT_DEFERRED_INDEXES_EVENT_SOURCE, summary })
      .catch((error: unknown) => {
        writeError(
          `alteroidd: 日誌の索引を作った結果を日誌へ残せませんでした: ${reasonOf(error)}\n`,
        );
      });
  };
  return {
    attach(target) {
      journal = target;
      if (pending !== undefined) {
        const summary = pending;
        pending = undefined;
        write(target, summary);
      }
    },
    note(outcomes) {
      const summary = describeDeferredIndexes(outcomes);
      writeLine(`alteroidd: ${summary}\n`);
      if (journal === undefined) {
        pending = summary;
        return;
      }
      write(journal, summary);
    },
  };
}
