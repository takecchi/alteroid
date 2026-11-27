import { noteBackgroundFailure } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_RECOVERY_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import {
  describeAwaitingBackgroundStall,
  describeAwaitingBackgroundStallRecovered,
} from './manager-notices.js';

/**
 * 背景処理待ちで畳んだ担当が、runner の数える背景処理が 0 本になってから（または最後の進捗の出来事から）次のターンを始めないまま
 * 続いたら知らせる長さ。環境変数にしない。
 * - CLI が完了通知で起こすターンは、通知から数秒で始まる。runner はターンの頭ごとに `session` の出来事を出し、それは
 *   `PROGRESS_EVENT_TYPES` に入っているので `lastEventAt` が進む。runner の観測（10 秒ごとの生存確認）は最大 10 秒遅れる。
 *   だから正常なら、10 分のあいだ何も来ないことは無い。
 * - 畳んだ報告をクローンへまとめて配る 30 分（`WITHHELD_REPORT_FLUSH_MS`）より前に知らせる意味がある。
 * - ターンの終わりの見回り（`TURN_END_PROBE_QUIET_MS`、10 分）と揃う。
 * - 進んでいる長いターンは道具の出来事を出すので、誤報にならない。
 */
export const MANAGER_AWAITING_BACKGROUND_STALL_NOTICE_MS = 10 * 60_000;

interface AwaitingBackgroundStallWatchDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  now: () => number;
  stopped: () => boolean;
  /** 背景処理待ちで畳んだ報告の本数。在庫が無い（背景処理待ちでない）なら `undefined`。 */
  withheldCount: (managerId: string) => number | undefined;
  /** runner の生存確認が名乗る、その担当の背景処理の本数。観測が無ければ `undefined`（0 と読まない）。 */
  liveBackgroundTasks: (record: ManagerRecord) => number | undefined;
  /** `Pool#emit(managerId, 'report', text)` を束ねたもの。 */
  emitReport: (managerId: string, text: string) => void;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
}

interface Observation {
  /** 監視者が「背景処理 0 本」を最初に見た時刻。 */
  readonly seenAt: number;
  /** 知らせた episode の基準時刻。立っている間は二度目を出さない。 */
  notifiedBase?: number;
}

/**
 * 背景処理待ちで畳んだまま、背景処理が 0 本なのに次のターンが始まらない担当を、1 episode につき 1 通だけクローンの受信箱へ知らせる。
 * 何も止めず、起こし直さず、台帳にも書かない（起こし直しは人間の決定でしない）。帳面はプロセス内（再起動すると猶予が延びる＝見逃し側に倒れる）。回復は日誌のみ。
 */
export class AwaitingBackgroundStallWatch {
  readonly #records: AwaitingBackgroundStallWatchDeps['records'];
  readonly #now: AwaitingBackgroundStallWatchDeps['now'];
  readonly #stopped: AwaitingBackgroundStallWatchDeps['stopped'];
  readonly #withheldCount: AwaitingBackgroundStallWatchDeps['withheldCount'];
  readonly #liveBackgroundTasks: AwaitingBackgroundStallWatchDeps['liveBackgroundTasks'];
  readonly #emitReport: AwaitingBackgroundStallWatchDeps['emitReport'];
  readonly #journalExchange: AwaitingBackgroundStallWatchDeps['journalExchange'];
  readonly #observations = new Map<string, Observation>();

  constructor(deps: AwaitingBackgroundStallWatchDeps) {
    this.#records = deps.records;
    this.#now = deps.now;
    this.#stopped = deps.stopped;
    this.#withheldCount = deps.withheldCount;
    this.#liveBackgroundTasks = deps.liveBackgroundTasks;
    this.#emitReport = deps.emitReport;
    this.#journalExchange = deps.journalExchange;
  }

  sweep(): void {
    if (this.#stopped()) return;
    const now = this.#now();
    for (const [managerId, record] of [...this.#records]) {
      if (this.#stopped()) break;
      try {
        this.#check(managerId, record, now);
      } catch (error) {
        noteBackgroundFailure('背景処理待ちの停滞の見張り', `managerId=${managerId}`, error);
      }
    }
    for (const managerId of [...this.#observations.keys()]) {
      if (!this.#records.has(managerId)) this.#observations.delete(managerId);
    }
  }

  #check(managerId: string, record: ManagerRecord, now: number): void {
    const lastEventMs = record.lastEventAt === undefined ? NaN : Date.parse(record.lastEventAt);
    const prior = this.#observations.get(managerId);

    // 知らせた後に出来事が来たら episode は終わり。条件の判定より先に見る（背景処理が増えても、戻ったことは残す）
    if (prior?.notifiedBase !== undefined && lastEventMs > prior.notifiedBase) {
      delete prior.notifiedBase;
      this.#recover(managerId, record);
    }

    const withheld = this.#withheldCount(managerId);
    if (!this.#stalledShape(record, withheld)) {
      // 次に条件が揃った周回を「最初の観測」にする
      this.#observations.delete(managerId);
      return;
    }

    const observation = prior ?? { seenAt: now };
    this.#observations.set(managerId, observation);
    const base = Math.max(Number.isNaN(lastEventMs) ? -Infinity : lastEventMs, observation.seenAt);
    if (now - base < MANAGER_AWAITING_BACKGROUND_STALL_NOTICE_MS) return;
    if (observation.notifiedBase !== undefined) return;

    // 出す前に印を立てる: 配達が投げても、次の周回で同じ知らせを積み直さない
    observation.notifiedBase = base;
    this.#notify(managerId, now - base, withheld ?? 0);
  }

  // 観測が無い（undefined）は 0 と読まない: 聞けていないものを「止まっている」の根拠にしない
  #stalledShape(record: ManagerRecord, withheld: number | undefined): boolean {
    if (record.job.status !== 'done') return false;
    if (!record.attached) return false;
    if (withheld === undefined) return false;
    return this.#liveBackgroundTasks(record) === 0;
  }

  // 日誌と report は別々に隔離する: どちらかが投げても、もう一方と周回を巻き込まない
  #notify(managerId: string, elapsedMs: number, withheldCount: number): void {
    const text = describeAwaitingBackgroundStall({ managerId, elapsedMs, withheldCount });
    try {
      void this.#journalExchange('outbound', `${EXCHANGE_KIND_FAILURE_PREFIX}${text}`).catch(
        (error: unknown) => {
          noteBackgroundFailure(
            '背景処理待ちの停滞の知らせの日誌',
            `managerId=${managerId}`,
            error,
          );
        },
      );
    } catch (error) {
      noteBackgroundFailure('背景処理待ちの停滞の知らせの日誌', `managerId=${managerId}`, error);
    }
    try {
      this.#emitReport(managerId, text);
    } catch (error) {
      noteBackgroundFailure('背景処理待ちの停滞の知らせ', `managerId=${managerId}`, error);
    }
  }

  #recover(managerId: string, record: ManagerRecord): void {
    if (record.lastEventType === undefined || record.lastEventAt === undefined) return;
    const text = describeAwaitingBackgroundStallRecovered({
      managerId,
      lastEventType: record.lastEventType,
      lastEventAt: record.lastEventAt,
    });
    try {
      void this.#journalExchange('outbound', `${EXCHANGE_KIND_RECOVERY_PREFIX}${text}`).catch(
        (error: unknown) => {
          noteBackgroundFailure('背景処理待ちの停滞の解消の日誌', `managerId=${managerId}`, error);
        },
      );
    } catch (error) {
      noteBackgroundFailure('背景処理待ちの停滞の解消の日誌', `managerId=${managerId}`, error);
    }
  }
}
