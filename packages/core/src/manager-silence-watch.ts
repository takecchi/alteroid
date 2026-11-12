import { noteBackgroundFailure } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_RECOVERY_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import { classifyManagerActivity } from './manager-activity.js';
import { describeSilenceNotice, describeSilenceRecovered } from './manager-notices.js';

/**
 * running の担当が、進捗の出来事を 1 本も出さないまま続いたら知らせる長さ。環境変数にしない。
 * 既存の「待ち」の最大（背景待ちのまとめ配り＝30 分）に揃えた。10 分だと長いビルド・長い推論で誤検出が増え、60 分だと放置が長い。
 */
export const MANAGER_SILENCE_NOTICE_MS = 30 * 60_000;

/**
 * `ManagerRecord.lastEventAt` を進める出来事（`noteProgressEvent`）。
 * **`mirror` を数えない**: SDK の `sessionStoreFlush` の既定は `'batched'` で、時間基準の flush が無く、ターンの終わり（`result`）か
 * 溜まりが 500 件／1 MiB を超えたときにしか届かない。長い 1 ターンの間は 1 本も届かないので、無音の信号に使うと進んでいる担当を無音と取り違える。
 * 数えない他の出来事: `usage`・`context_usage`・`usage_notice`・`rate_limit`（ターン境界の外でも flush される）、`archive`、`rescue_*`、
 * `external_output`、`project_key`（mirror と対で出る）、`closed`・`resume_failed`（別の経路が扱う）。
 */
const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool_use',
  'tool_running',
  'tool_end',
  'report',
  'ask',
  'settled',
  'note',
  'permission_denied',
  'session',
]);

/** `Pool#handleEvent` の入口から呼ぶ（古い世代の出来事を捨てた後）。プロセス内の像にしか書かない。 */
export function noteProgressEvent(
  record: ManagerRecord,
  event: { type: string; tool?: string },
  nowIso: string,
): void {
  if (!PROGRESS_EVENT_TYPES.has(event.type)) return;
  record.lastEventAt = nowIso;
  record.lastEventType = event.type;
  // 道具の実行中だけ名前を持つ（次の出来事で消える）
  record.lastEventTool = event.type === 'tool_running' ? event.tool : undefined;
}

interface SilenceWatchDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  now: () => number;
  stopped: () => boolean;
  /**
   * `Pool` だけが知る理由で「無音」と読まない担当か: 枠停止中・runner lost・名簿から消えた・peer の承認待ち。
   * 別の印が既に出ている／人間や枠の都合で待っているのであって、ハングではない。
   */
  heldElsewhere: (record: ManagerRecord) => boolean;
  /** `Pool#emit(managerId, 'report', text)` を束ねたもの。 */
  emitReport: (managerId: string, text: string) => void;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
}

interface Observation {
  /** 監視者が `running` を最初に見た時刻。`running` へ戻す側（5 箇所以上ある）に印を足さず、ここで持つ。 */
  readonly seenAt: number;
  /** 知らせた episode の基準時刻。立っている間は二度目を出さない。 */
  notifiedBase?: number;
}

/**
 * running のまま進捗の出来事が `MANAGER_SILENCE_NOTICE_MS` 無い担当を、1 episode につき 1 通だけクローンの受信箱へ知らせる。
 * 何も止めず、台帳にも書かない。帳面はプロセス内（再起動すると猶予が延びる＝見逃し側に倒れる）。回復は日誌のみ。
 */
export class SilenceWatch {
  readonly #records: SilenceWatchDeps['records'];
  readonly #now: SilenceWatchDeps['now'];
  readonly #stopped: SilenceWatchDeps['stopped'];
  readonly #heldElsewhere: SilenceWatchDeps['heldElsewhere'];
  readonly #emitReport: SilenceWatchDeps['emitReport'];
  readonly #journalExchange: SilenceWatchDeps['journalExchange'];
  readonly #observations = new Map<string, Observation>();

  constructor(deps: SilenceWatchDeps) {
    this.#records = deps.records;
    this.#now = deps.now;
    this.#stopped = deps.stopped;
    this.#heldElsewhere = deps.heldElsewhere;
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
        noteBackgroundFailure('無音の見張り', `managerId=${managerId}`, error);
      }
    }
    for (const managerId of [...this.#observations.keys()]) {
      if (!this.#records.has(managerId)) this.#observations.delete(managerId);
    }
  }

  #check(managerId: string, record: ManagerRecord, now: number): void {
    const lastEventMs = record.lastEventAt === undefined ? NaN : Date.parse(record.lastEventAt);
    const prior = this.#observations.get(managerId);

    // 知らせた後に出来事が来たら episode は終わり。除外の判定より先に見る（返事待ちなどへ移っても、戻ったことは残す）
    if (prior?.notifiedBase !== undefined && lastEventMs > prior.notifiedBase) {
      delete prior.notifiedBase;
      this.#recover(managerId, record);
    }

    if (!this.#watchable(record)) {
      // 次に対象へ戻った周回を「最初の観測」にする: 返事待ち・runner lost などの間の経過を無音に数えない
      this.#observations.delete(managerId);
      return;
    }

    const observation = prior ?? { seenAt: now };
    this.#observations.set(managerId, observation);
    const base = Math.max(Number.isNaN(lastEventMs) ? -Infinity : lastEventMs, observation.seenAt);
    if (now - base < MANAGER_SILENCE_NOTICE_MS) return;
    if (observation.notifiedBase !== undefined) return;

    // 出す前に印を立てる: 配達が投げても、次の周回で同じ知らせを積み直さない
    observation.notifiedBase = base;
    this.#notify(managerId, record, now - base);
  }

  #watchable(record: ManagerRecord): boolean {
    if (record.job.status !== 'running') return false;
    if (record.waiting.length > 0) return false;
    if (!record.attached) return false;
    if (record.sessionMissingSince !== undefined || record.leaseRefusal !== undefined) return false;
    if (this.#heldElsewhere(record)) return false;
    // end_turn の後の報告欠落は `#recoverUndelivered` が受信箱へ出す。重ねない
    const activity = classifyManagerActivity({
      turnEndReason: record.turnEndReason,
      turnEndedAt: record.turnEndedAt,
      lastReportAt: record.job.lastReportAt,
      toolUseStallPending: record.toolUseStallPending,
      waitingCount: record.waiting.length,
    });
    return activity !== 'stalled-turn-end';
  }

  // 日誌と report は別々に隔離する: どちらかが投げても、もう一方と周回を巻き込まない
  #notify(managerId: string, record: ManagerRecord, elapsedMs: number): void {
    const text = describeSilenceNotice({
      managerId,
      elapsedMs,
      lastEventType: record.lastEventType,
      lastEventAt: record.lastEventAt,
      runningTool: record.lastEventTool,
    });
    try {
      void this.#journalExchange('outbound', `${EXCHANGE_KIND_FAILURE_PREFIX}${text}`).catch(
        (error: unknown) => {
          noteBackgroundFailure('無音の知らせの日誌', `managerId=${managerId}`, error);
        },
      );
    } catch (error) {
      noteBackgroundFailure('無音の知らせの日誌', `managerId=${managerId}`, error);
    }
    try {
      this.#emitReport(managerId, text);
    } catch (error) {
      noteBackgroundFailure('無音の知らせ', `managerId=${managerId}`, error);
    }
  }

  #recover(managerId: string, record: ManagerRecord): void {
    if (record.lastEventType === undefined || record.lastEventAt === undefined) return;
    const text = describeSilenceRecovered({
      managerId,
      lastEventType: record.lastEventType,
      lastEventAt: record.lastEventAt,
    });
    try {
      void this.#journalExchange('outbound', `${EXCHANGE_KIND_RECOVERY_PREFIX}${text}`).catch(
        (error: unknown) => {
          noteBackgroundFailure('無音の解消の日誌', `managerId=${managerId}`, error);
        },
      );
    } catch (error) {
      noteBackgroundFailure('無音の解消の日誌', `managerId=${managerId}`, error);
    }
  }
}
