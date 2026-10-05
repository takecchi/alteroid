import {
  dailyReportEvent,
  EXCHANGE_KIND_FAILURE_PREFIX,
  missingDailyReportDates,
  reasonOf,
} from '@alteroid/core';
import type { InboxEvent, JournalEntry, JournalStore, TimeOfDay } from '@alteroid/core';

/**
 * 起動時の日報の後追い（取りこぼした日の拾い直し）。
 *
 * 日誌を読めずに調べられなかったとき、(1) stderr だけでなく日誌にも `[失敗]` の跡を
 * 残し（日誌へ書けないときは stderr に落ちる。二重に失敗しても投げない）、(2) 間隔を
 * 空けて有限回、調べ直す（#2908）。間隔は #2783 の日報の作り直し
 * （`DAILY_REPORT_RETRY_DELAYS_MS`）と揃える。使い切ったら諦める（跡は残っている）。
 * 調べ直しで見つかった日は、起動時と同じ `schedule_catchup` で積む。
 */
export interface DailyReportCatchupOptions {
  journal: Pick<JournalStore, 'listPage' | 'append'>;
  at: TimeOfDay;
  lookbackDays: number;
  post: (event: InboxEvent) => void;
  /** 調べ直しの間隔。要素数が回数の上限。 */
  retryDelaysMs: readonly number[];
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface DailyReportCatchup {
  /** 待機中の調べ直しを破棄する。 */
  stop(): void;
}

export function startDailyReportCatchup(options: DailyReportCatchupOptions): DailyReportCatchup {
  const now = options.now ?? ((): Date => new Date());
  const stdout = options.stdout ?? ((line: string) => void process.stdout.write(line));
  const stderr = options.stderr ?? ((line: string) => void process.stderr.write(line));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = async (done: number): Promise<void> => {
    if (stopped) return;
    let missed: string[];
    try {
      missed = await missingDailyReportDates({
        journal: options.journal as JournalStore,
        at: options.at,
        now: now(),
        lookbackDays: options.lookbackDays,
      });
    } catch (error) {
      const delay = options.retryDelaysMs[done];
      const reason = reasonOf(error);
      const next =
        delay === undefined
          ? '調べ直しの回数を使い切ったので、これ以上は拾い直さない（再起動で再び試す）。'
          : `${Math.round(delay / 60_000)} 分後に調べ直す（${String(done + 1)}/${String(options.retryDelaysMs.length)} 回目の待ち）。`;
      const text =
        `${EXCHANGE_KIND_FAILURE_PREFIX}取りこぼした日報を調べられなかった` +
        `（日誌を読めなかった。理由: ${reason}）。${next}`;
      stderr(`alteroidd: ${text}\n`);
      try {
        const entry: Omit<JournalEntry, 'at'> = {
          type: 'exchange',
          with: 'self',
          role: 'outbound',
          text,
        } as never;
        await options.journal.append(entry as never);
      } catch (writeError) {
        stderr(`alteroidd: 上の失敗を日誌にも残せませんでした: ${reasonOf(writeError)}\n`);
      }
      if (delay === undefined || stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        void attempt(done + 1);
      }, delay);
      timer.unref();
      return;
    }
    // 調べ直しで見つかった分も、起動時と同じ印（`schedule_catchup`）で積む。
    for (const date of missed) options.post(dailyReportEvent(date, now(), 'schedule_catchup'));
    if (missed.length > 0) {
      stdout(`alteroidd: 取りこぼした日報を作ります: ${missed.join(', ')}\n`);
    }
  };

  void attempt(0);
  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
