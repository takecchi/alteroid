import type { TurnOutcome } from './clone.js';
import type { CloneDigest } from './clone-digest.js';
import { buildActivityDigest } from './digest.js';
import { reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_DECISION_PREFIX, EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { buildDailyReportPrompt } from './prompt.js';
import { dailyReportEvent, localDayRange } from './schedule.js';
import { isDailyReport, isWrittenDailyReport } from './schema.js';
import type { InboxEvent, JournalEntry, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { turnInputEntry } from './turn-input.js';

const DAILY_REPORT_LOOKUP = 30;

/**
 * `Clone` が協力者へ渡す口。
 * 口の戻りは Promise を直に返す（`runInternal: (text) => this.#runInternal(text)`、`journal: (entry) => this.#journal(entry)`）:
 * 間に `async` の関数を挟むと `await` の段が増え、日報のターンと日誌の書き込みの時機が動く。`post` は同期のまま。
 * 構築の途中でこの協力者を作るので、`stores`・`tokenSavingExcerpt` は値ではなく読む関数にする。
 */
export interface CloneDailyReportPorts {
  /** `Clone` の `#stores` */
  stores(): Stores;
  /** `Clone` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
  /** `Clone` の `#runInternal`（ターン 1 本を回す重い本体なので `Clone` に残る） */
  runInternal(text: string): Promise<TurnOutcome>;
  /** `Clone` の `post`（再試行の timer が追い合図を投函する） */
  post(event: InboxEvent): void;
  /** `Clone` の `#tokenSavingExcerpt` */
  tokenSavingExcerpt(): boolean;
}

/**
 * 日報（1 日 1 本の活動の記録）を書き、失敗した回を有限回だけ作り直す協力者。
 * 状態は作り直しの回数（`#retries`）と仕掛かっている timer（`#retryTimers`）で、`Clone` の `stop()` が `dispose()` で timer を消す。
 * `run` は元の `#dailyReport` と同じく `async` のまま移した（外側を包まない）: `Clone` の `await this.#daily.run(...)` が 1 段のままであるため。
 */
export class CloneDailyReport {
  readonly #ports: CloneDailyReportPorts;
  readonly #digest: CloneDigest;
  readonly #retryDelays: readonly number[];
  readonly #retries = new Map<string, number>();
  readonly #retryTimers = new Set<ReturnType<typeof setTimeout>>();

  /** `retryDelays`: 作り直しの間隔。`Clone` の `dailyReportRetryDelaysMs ?? DAILY_REPORT_RETRY_DELAYS_MS`（既定値は `clone.ts` が export している） */
  constructor(ports: CloneDailyReportPorts, digest: CloneDigest, retryDelays: readonly number[]) {
    this.#ports = ports;
    this.#digest = digest;
    this.#retryDelays = retryDelays;
  }

  /** 仕掛かっている作り直しの timer を全部消す。同期（`stop()` の先頭で、早期 return の前に呼ぶ）。 */
  dispose(): void {
    for (const timer of this.#retryTimers) clearTimeout(timer);
    this.#retryTimers.clear();
  }

  // 書かれなかった日を作らない（道具を呼び忘れたらその応答を日報にする）。ただし失敗したターンの応答は日報にしない: エラー文言が日報として保存されるため。失敗時は `unavailable`（`schema.ts`）の印を付けた行だけを書く。
  // 読めなければ「無い」として走らせる側へ倒す: 引き下がると、本物の日報が永久に書かれない恐れがあるため（下の既存確認と同じ理由）
  async #written(date: string): Promise<boolean> {
    try {
      const written: JournalEntry[] = await this.#ports.stores().journal.list({
        types: ['daily_report'],
        limit: DAILY_REPORT_LOOKUP,
      });
      return written
        .filter(isDailyReport)
        .some((entry) => entry.date === date && isWrittenDailyReport(entry));
    } catch {
      return false;
    }
  }

  async run(
    date: string,
    cause: 'schedule' | 'schedule_catchup' | 'manual' = 'schedule',
  ): Promise<void> {
    // 走らせる前にも見る（#4757）: 同じ日付の合図が2本積まれる（受信箱に残った定時の合図と起動時の後追い）と、2本目もターンを丸ごと払ってから下の確認で捨てるため。
    // `manual` は除く: 人間が作り直しを頼んだ回は、既にあっても走らせる
    if (cause !== 'manual' && (await this.#written(date))) {
      this.#retries.delete(date);
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}${date} の日報は既に書かれているので、日報のターンを走らせなかった（契機: ${cause}）`,
      );
      return;
    }
    const range = localDayRange(date);
    const axes = range === null ? null : await this.#digest.axes();
    const digest =
      range === null || axes === null
        ? await this.#digest.bare()
        : await buildActivityDigest(
            this.#ports.stores(),
            range,
            axes.liveness,
            axes.awaitingBackground,
            {
              trimHistory: this.#ports.tokenSavingExcerpt(),
            },
          ).catch(
            async (error: unknown) =>
              `（この日の記録をまとめられなかった: ${reasonOf(error)}）${await this.#digest.taskQueueHeadAfterFailure()}`,
          );

    // digest の全文は日誌に書かない（`turn-input.ts` の doc）。
    await this.#ports.journal(turnInputEntry({ type: 'daily_report', date, cause, digest }));

    const outcome = await this.#ports.runInternal(buildDailyReportPrompt({ date, digest }));

    // 枠で保持しているなら痕跡を残さず引き下がる: 印だけでも書くと、下の早期 return と `missingDailyReportDates`（`schedule.ts`）が「もう書いた」と判断し、本物の日報が永久に書かれないため。
    if (outcome.status === 'failed' && outcome.heldForUsage) return;

    // 読めなかった回を「日報が無い」と扱わない・かといって書かずに引き下がりもしない: 既存確認の失敗には配り直しが無く、後追いは起動時に1回だけで、引き下がると本物の日報が永久に書かれないため。書くが重複の可能性を日誌に残し、失敗の回の印は1日1件を確かめられないので積まない。
    let existing: JournalEntry[] = [];
    try {
      const written: JournalEntry[] = await this.#ports.stores().journal.list({
        types: ['daily_report'],
        limit: DAILY_REPORT_LOOKUP,
      });
      existing = written.filter(isDailyReport).filter((entry) => entry.date === date);
    } catch (error) {
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}日報の既存確認（${date}）で日誌を読めなかった` +
          `（理由: ${reasonOf(error)}）。` +
          (outcome.status === 'failed'
            ? 'この日の日報が既にあるか確かめられなかったので、「作れなかった」の印は書かなかった。'
            : 'この日の日報が既にあるか確かめられないまま書いた。同じ日に日報が2本ある' +
              'ならこの回の重複（消さずに日誌から辿ること）。'),
      );
      if (outcome.status === 'failed') {
        // 印を書けなかっただけで、失敗した日報であることは変わらない: 再起動まで待たずに作り直す。
        this.#scheduleRetry(date);
        return;
      }
    }
    // **印の付いた行は「日報がある」と数えない**（`schema.ts` の `unavailable` の
    // doc）。数えると、後から本物を書き直す道が閉じる。
    if (existing.some(isWrittenDailyReport)) return;

    if (outcome.status === 'failed') {
      // 印は1日1件でよい。**積むと人間が読む唯一の層が「作れなかった」で埋まる。**
      // 失敗が続いた回数は日誌（`#reportFailure`）に全部残っているので、ここで
      // 数える必要は無い。
      if (existing.length === 0)
        await this.#ports.journal({
          type: 'daily_report',
          date,
          // SDK の文言を言い換えない（`usage-limits.ts`）: 人間が検索できる形で残すため。本文ではなく書けなかった理由として置く。
          body: `（この日の日報は作れなかった。日誌から直接辿ること。理由: ${outcome.reason}）`,
          unavailable: outcome.reason,
        });
      // 印だけで終わりにしない: 後追い（`missingDailyReportDates`）は起動時に1回しか走らず、枠切れ以外の失敗は一時的なことが多いため。
      this.#scheduleRetry(date);
      return;
    }
    this.#retries.delete(date);

    await this.#ports.journal({
      type: 'daily_report',
      date,
      body:
        outcome.text.trim().length > 0
          ? outcome.text
          : '（クローンがこの日の日報を残さなかった。日誌から直接辿ること。）',
    });
  }

  #scheduleRetry(date: string): void {
    const done = this.#retries.get(date) ?? 0;
    const delay = this.#retryDelays[done];
    if (delay === undefined) return;
    this.#retries.set(date, done + 1);
    const timer = setTimeout(() => {
      this.#retryTimers.delete(timer);
      this.#ports.post(dailyReportEvent(date, new Date(), 'schedule_catchup'));
    }, delay);
    timer.unref();
    this.#retryTimers.add(timer);
  }

  // `Clone` の `#journalSelf` と同じ形で、ここにも1本置く（`this.#ports.journalSelf(...)` の字面にしない: ソース走査の試験（`clone-journal-self-sites-pin`・`exchange-kind-coverage`）が `#journalSelf(` の呼びで書き手を数えるため）。`Clone` 側は他の書き手が使うので共有できない
  #journalSelf(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#ports.journal({ type: 'exchange', with: 'self', role, text });
  }
}
