import { randomUUID } from 'node:crypto';

import { parseCron } from './cron.js';
import { noteBackgroundFailure, reasonOf } from './dropped-record.js';
import { compareIsoInstant } from './iso-instant.js';
import { isWrittenDailyReport } from './schema.js';
import type {
  InboxEvent,
  SchedulePhase,
  ScheduleSpec,
  ScheduledRequest,
  UnreadableSchedule,
} from './schema.js';
import type { InboxStore, JournalQuery, JournalStore, ScheduleStore } from './store.js';

// 実行回数の上限や「連続で N 回まで」の抑止を置かない: 走り続ける前提そのものを動かさないため（AGENTS.md 地雷2）

export interface ScheduleEntry {
  kind: string;
  description: string;
  nextAt(after: Date): Date;
  event(at: Date, scheduledAt?: Date): InboxEvent;
  // 日報で拾い直しの経路を2つにしない: 同じ日の日報が二重に立つため
  catchUpMissed?: boolean;
}

export interface ScheduleStatus {
  kind: string;
  description: string;
  nextAt: string;
  request?: string;
  spec?: ScheduleSpec;
  lastRunAt?: string;
  // 既定の日報・発意 tick に `unknown` を入れない: 「在るはずだが根拠が無い」を表す値で、探しに行く人が出るため
  createdAt?: string;
  updatedAt?: string;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  list(): ScheduleStatus[];
  unreadable(): UnreadableSchedule[];
  run(kind: string): boolean;
  tick(now?: Date): string[];
  retrySoon(kind: string, delayMs?: number): void;
  // スケジューラへ直接 add する口を作らない: ストアと仕込みの二重管理になり、デーモンの再起動で依頼が消えるため
  refresh(): Promise<void>;
  settled(): Promise<void>;
}

export interface SchedulerOptions {
  entries: ScheduleEntry[];
  post: (event: InboxEvent) => void;
  now?: () => Date;
  schedules?: ScheduleStore;
  // `claimPending()` を使わない: 配達回数を進めてしまうため（読むのは `peekPending()` だけ）
  inbox?: Pick<InboxStore, 'peekPending'>;
  // 省略時の既定を何もしないにしない: 渡し忘れた呼び出し側が静かに失敗するため（stderr へ出す）
  onError?: (message: string) => void;
}

// 長い setTimeout 1本にしない: 蓋を閉じたノートを開いた後や時計が飛んだ後に予定が黙って腐るため
const MAX_SLEEP_MS = 60_000;

// 現在時刻を基準にしない（錨から数える）: every が再起動のたびに後ろへずれるため
// 格子を引き直した直後に呼ばない: 古い格子の seed が新しい格子で過去になり、catch-up が誤発火するため
function dueFromSeed(entry: ScheduleEntry, seed: Date, now: Date): { at: Date; catchUp: boolean } {
  const fromSeed = entry.nextAt(seed);
  if (fromSeed.getTime() <= now.getTime()) {
    return entry.catchUpMissed === false
      ? { at: entry.nextAt(now), catchUp: false }
      : { at: now, catchUp: true };
  }
  // nextAt(now) より後ろにしない: 時計のずれや未来の日付で永久に沈黙しないため
  return {
    at: new Date(Math.min(fromSeed.getTime(), entry.nextAt(now).getTime())),
    catchUp: false,
  };
}

export const SCHEDULE_RETRY_MS = 60_000;

export function createScheduler(options: SchedulerOptions): Scheduler {
  return new TimerScheduler(options);
}

interface UnreadTimer {
  at: string;
  cause: 'schedule' | 'schedule_catchup' | 'manual' | undefined;
}

class TimerScheduler implements Scheduler {
  readonly #base: ScheduleEntry[];
  readonly #requests = new Map<
    string,
    { entry: ScheduleEntry; spec: string; plan: ScheduledRequest }
  >();
  readonly #post: (event: InboxEvent) => void;
  readonly #now: () => Date;
  readonly #store: ScheduleStore | undefined;
  readonly #inbox: Pick<InboxStore, 'peekPending'> | undefined;
  readonly #due = new Map<string, number>();
  #unreadable: UnreadableSchedule[] = [];

  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #refreshing: Promise<void> | null = null;
  // 同じ回を配り直すのは1度だけ: 刻みごとに配り続けると受け取る側から見て二重の仕事になるため
  readonly #redelivered = new Map<string, string>();
  readonly #catchUp = new Set<string>();
  readonly #onError: (message: string) => void;
  readonly #phases = new Map<string, SchedulePhase>();
  // 位相を2度読まない: その刻みで進めた `#due` を古い位相で巻き戻し、同じ回を刻みごとに撃ち続けるため
  readonly #seeded = new Set<string>();
  #writes: Promise<void> = Promise.resolve();

  constructor({ entries, post, now, schedules, inbox, onError }: SchedulerOptions) {
    this.#base = entries;
    this.#post = post;
    this.#now = now ?? (() => new Date());
    this.#store = schedules;
    this.#inbox = inbox;
    this.#onError =
      onError ??
      ((message): void => {
        process.stderr.write(`alteroid: ${message}\n`);
      });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const now = this.#now();
    for (const entry of this.#entries()) {
      if (!this.#due.has(entry.kind)) this.#due.set(entry.kind, entry.nextAt(now).getTime());
    }
    this.#arm();
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  list(): ScheduleStatus[] {
    const now = this.#now();
    return this.#entries().map((entry) => {
      const plan = this.#requests.get(entry.kind)?.plan;
      const lastRunAt = plan?.lastRunAt ?? this.#phases.get(entry.kind)?.lastRunAt;
      return {
        kind: entry.kind,
        description: entry.description,
        nextAt: new Date(this.#due.get(entry.kind) ?? entry.nextAt(now).getTime()).toISOString(),
        ...(plan === undefined
          ? {}
          : {
              request: plan.request,
              spec: plan.spec,
              createdAt: plan.createdAt,
              updatedAt: plan.updatedAt,
            }),
        ...(lastRunAt === undefined ? {} : { lastRunAt }),
      };
    });
  }

  unreadable(): UnreadableSchedule[] {
    return [...this.#unreadable];
  }

  run(kind: string): boolean {
    const entry = this.#entries().find((candidate) => candidate.kind === kind);
    if (!entry) return false;
    const now = this.#now();
    const event = entry.event(now);
    this.#recordPhase(entry, now, 'manual');
    // `cause` を省略しない: 手動実行が既定の `schedule`（定刻どおり）に落ち、`/run self_initiative` が定刻どおりに起きたと嘘をつくため
    this.#post(
      event.type === 'timer' || event.type === 'self_initiative'
        ? { ...event, cause: 'manual' }
        : event,
    );
    return true;
  }

  // 「増えなくなるまで待つ」ループにしない: `#recordPhase` は `await` を挟まず `#writes` を差し替えるので1本待てば足りるため
  async settled(): Promise<void> {
    await this.#writes;
  }

  // 読み直しを並行に走らせない: 先に読み始めた側が古い一覧で `#requests` を上書きし、外した依頼が復活するため
  refresh(): Promise<void> {
    const run = (this.#refreshing ?? Promise.resolve()).then(() => this.#reconcile());
    this.#refreshing = run.catch(() => undefined);
    return run;
  }

  async #reconcile(): Promise<void> {
    if (this.#store === undefined) return;
    await this.#seedBase();
    const list = await this.#store.list();
    const plans = list.entries;
    this.#unreadable = list.unreadable;
    const now = this.#now();
    const seen = new Set<string>();
    let unreadTimers: Map<string, UnreadTimer[]> | undefined;

    for (const plan of plans) {
      // 既定の仕込みと同じ名前は乗っ取らせない: 日報を「定期の依頼」で潰せてしまうため
      if (this.#base.some((entry) => entry.kind === plan.kind)) continue;
      seen.add(plan.kind);
      const spec = JSON.stringify(plan.spec);
      const existing = this.#requests.get(plan.kind);
      if (plan.pendingRun === undefined) this.#redelivered.delete(plan.kind);
      if (existing?.spec === spec) {
        existing.plan = plan;
        continue;
      }
      const entry = scheduledRequestEntry(plan);
      this.#requests.set(plan.kind, { entry, spec, plan });
      // `existing === undefined`（器の作り直し・初めての仕込み）を specChanged にしない: 本当の取りこぼしを拾えなくなるため
      const specChanged = existing !== undefined;
      unreadTimers ??= await this.#readUnreadTimers();
      const due = this.#firstDue(entry, plan, now, specChanged, unreadTimers.get(plan.kind) ?? []);
      this.#due.set(plan.kind, due.at.getTime());
      if (due.catchUp) this.#catchUp.add(plan.kind);
      else this.#catchUp.delete(plan.kind);
    }

    for (const kind of [...this.#requests.keys()]) {
      if (seen.has(kind)) continue;
      this.#requests.delete(kind);
      this.#due.delete(kind);
      this.#redelivered.delete(kind);
      this.#catchUp.delete(kind);
    }

    this.#arm();
  }

  #firstDue(
    entry: ScheduleEntry,
    plan: ScheduledRequest,
    now: Date,
    specChanged: boolean,
    unread: readonly UnreadTimer[],
  ): { at: Date; catchUp: boolean } {
    // 未読の timer 行が残る回は撃たない: 未読側が元の回として配り直すので、撃つと同じ回が二重に走るため
    if (plan.pendingRun !== undefined) {
      const pendingAt = plan.pendingRun.at;
      if (unread.some((row) => compareIsoInstant(row.at, pendingAt) === 0)) {
        return { at: entry.nextAt(now), catchUp: false };
      }
      return { at: now, catchUp: false };
    }

    // 周期を差し替えた直後は seed を経由しない: 古い格子の seed が新しい格子で過去に落ち、catch-up が誤発火するため
    if (specChanged) return { at: entry.nextAt(now), catchUp: false };

    // `lastRunAt` を基準にしない: 手で起こすたびに位相が動くため
    const seed = new Date(plan.lastScheduledRunAt ?? plan.createdAt);
    if (Number.isNaN(seed.getTime())) return { at: entry.nextAt(now), catchUp: false };

    const due = dueFromSeed(entry, seed, now);
    if (due.catchUp) {
      const slot = entry.nextAt(seed);
      const covered = unread.some(
        (row) => row.cause !== 'manual' && compareIsoInstant(row.at, slot.toISOString()) >= 0,
      );
      if (covered) return { at: entry.nextAt(now), catchUp: false };
    }
    return due;
  }

  async #readUnreadTimers(): Promise<Map<string, UnreadTimer[]>> {
    const byKind = new Map<string, UnreadTimer[]>();
    if (this.#inbox === undefined) return byKind;
    try {
      const peek = await this.#inbox.peekPending();
      for (const { event } of peek.entries) {
        if (event.type !== 'timer') continue;
        const rows = byKind.get(event.kind) ?? [];
        rows.push({ at: event.at, cause: event.cause });
        byKind.set(event.kind, rows);
      }
    } catch (error) {
      this.#onError(
        `受信箱の未読の timer を読めなかった（同じ回が二重に走りうる側へ倒れる）: ${reasonOf(error)}`,
      );
      return new Map();
    }
    return byKind;
  }

  async #seedBase(): Promise<void> {
    const store = this.#store;
    if (store === undefined) return;
    for (const entry of this.#base) {
      if (this.#seeded.has(entry.kind)) continue;
      let phase: SchedulePhase | null;
      try {
        phase = await store.getPhase(entry.kind);
      } catch (error) {
        this.#onError(
          `定期ジョブ ${entry.kind} の位相を読めなかった（次の刻みで読み直す）: ${reasonOf(error)}`,
        );
        continue;
      }
      this.#seeded.add(entry.kind);
      if (phase === null) continue;
      this.#phases.set(entry.kind, phase);
      if (phase.lastScheduledRunAt === undefined) continue;
      const seed = new Date(phase.lastScheduledRunAt);
      if (Number.isNaN(seed.getTime())) continue;
      const due = dueFromSeed(entry, seed, this.#now());
      this.#due.set(entry.kind, due.at.getTime());
      if (due.catchUp) this.#catchUp.add(entry.kind);
      else this.#catchUp.delete(entry.kind);
    }
  }

  // 「完了時に進める」にしない: 完了を記録できないまま落ちた回が刻みごとに撃たれ続け、二重の仕事になるため
  #recordPhase(entry: ScheduleEntry, at: Date, cause: 'schedule' | 'manual'): void {
    const store = this.#store;
    if (store === undefined) return;
    if (!this.#base.some((base) => base.kind === entry.kind)) return;

    const stamp = at.toISOString();
    const carried = this.#phases.get(entry.kind)?.lastScheduledRunAt;
    const scheduled = cause === 'schedule' ? stamp : carried;
    const phase: SchedulePhase = {
      kind: entry.kind,
      lastRunAt: stamp,
      ...(scheduled === undefined ? {} : { lastScheduledRunAt: scheduled }),
    };
    this.#phases.set(entry.kind, phase);
    this.#writes = this.#writes.then(async () => {
      try {
        await store.putPhase(phase);
      } catch (error) {
        this.#onError(
          `定期ジョブ ${entry.kind} の位相を保存できなかった（この回を次の起動でもう一度起こす側に倒れる）: ${reasonOf(error)}`,
        );
      }
    });
  }

  #entries(): ScheduleEntry[] {
    return [...this.#base, ...[...this.#requests.values()].map((held) => held.entry)];
  }

  retrySoon(kind: string, delayMs: number = SCHEDULE_RETRY_MS): void {
    const due = this.#due.get(kind);
    if (due === undefined) return;
    // 「もう配った」と数えない: 数えると、配り直した回がまた失敗したとき次の刻みが元の回ではなく新しい回になるため
    this.#redelivered.delete(kind);
    const retryAt = this.#now().getTime() + Math.max(delayMs, 0);
    if (due <= retryAt) return;
    this.#due.set(kind, retryAt);
    this.#arm();
  }

  tick(now: Date = this.#now()): string[] {
    const fired: string[] = [];
    for (const entry of this.#entries()) {
      const due = this.#due.get(entry.kind);
      if (due === undefined || due > now.getTime()) continue;

      const resume = this.#resumable(entry.kind);
      if (resume !== undefined) {
        this.#redelivered.set(entry.kind, resume.at);
        // 次の予定を配り直した発火の時刻から数えない: 手で起こした1回が予定を動かし、止まっていたときは過去が次回になって余分な発火が続くため
        this.#due.set(entry.kind, entry.nextAt(now).getTime());
        // 印は必ず捨てる: 捨てないと次の定刻どおりの発火まで「取りこぼしの拾い直し」のまま残るため
        this.#catchUp.delete(entry.kind);
        fired.push(entry.kind);
        const event = entry.event(now);
        this.#post(
          event.type === 'timer' ? { ...event, at: resume.at, cause: resume.cause } : event,
        );
        continue;
      }

      const catchUp = this.#catchUp.delete(entry.kind);
      // 次の予定を post の前に決める: イベント投入で例外が出ても同じ発火を繰り返し続けない（暴走しない）ため
      this.#due.set(entry.kind, entry.nextAt(now).getTime());
      fired.push(entry.kind);
      this.#recordPhase(entry, now, 'schedule');
      const event = entry.event(now, new Date(due));
      this.#post(
        (event.type === 'timer' || event.type === 'self_initiative') && catchUp
          ? { ...event, cause: 'schedule_catchup' }
          : event,
      );
    }
    return fired;
  }

  // 現在時刻に置き換えない: 完了時に記録される基準が復旧時刻になって位相がずれるため
  #resumable(kind: string): { at: string; cause: 'schedule' | 'manual' } | undefined {
    const pending = this.#requests.get(kind)?.plan.pendingRun;
    if (pending === undefined) return undefined;
    return this.#redelivered.get(kind) === pending.at ? undefined : pending;
  }

  #arm(): void {
    if (!this.#started) return;
    if (this.#timer !== null) clearTimeout(this.#timer);

    const now = this.#now().getTime();
    const next = Math.min(...[...this.#due.values()], now + MAX_SLEEP_MS);
    const delay = Math.min(Math.max(next - now, 0), MAX_SLEEP_MS);

    this.#timer = setTimeout(() => {
      this.#timer = null;
      void (async () => {
        try {
          await this.#refreshQuietly();
          // 待っている間に止められていたら起こさない: シャットダウン中に新しいターンが走り、マネージャーまで起きうるため
          if (!this.#started) return;
          this.tick();
        } catch (error: unknown) {
          // 握り潰さない: `#arm()` で時計だけが進み、この刻みで配るはずだった依頼がプロセスが生きている間二度と来ないため
          noteBackgroundFailure('仕込みの刻み', '', error);
          throw error;
        } finally {
          this.#arm();
        }
      })();
    }, delay);
  }

  async #refreshQuietly(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // 読めなかったときに仕込み済みの予定を捨てない: DB の瞬断で継続中の依頼が黙って消えるため
    }
  }
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export function parseTimeOfDay(value: string): TimeOfDay | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function localDate(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, 0);
}

// 形だけ見て通さない: `Date` は `2026-02-31` を黙って別の日に繰り上げ、書いた日と読める日がずれるため
export function localDayRange(date: string): { since: Date; until: Date } | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const since = new Date(year, month, day, 0, 0, 0, 0);
  if (localDate(since) !== date) return null;
  return { since, until: new Date(year, month, day + 1, 0, 0, 0, 0) };
}

function atTimeOnDay(day: Date, time: TimeOfDay): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
}

export function dailyReportEvent(
  target: string,
  at: Date = new Date(),
  cause?: 'schedule_catchup',
): InboxEvent {
  return {
    type: 'timer',
    id: randomUUID(),
    at: at.toISOString(),
    kind: DAILY_REPORT_KIND,
    target,
    ...(cause === undefined ? {} : { cause }),
  };
}

export const DAILY_REPORT_KIND = 'daily_report';

export function dailyReportEntry(options: { at: TimeOfDay }): ScheduleEntry {
  const { at } = options;
  const label = `${`${at.hour}`.padStart(2, '0')}:${`${at.minute}`.padStart(2, '0')}`;

  return {
    kind: DAILY_REPORT_KIND,
    description: `毎日 ${label}（ローカル時刻）にその日の日報をまとめる`,
    // 拾い直しをここでやらない: `missingDailyReportDates` と両方で拾うと同じ日の日報が二重に立つため
    catchUpMissed: false,
    nextAt(after) {
      const today = atTimeOnDay(after, at);
      if (today.getTime() > after.getTime()) return today;
      const tomorrow = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
      return atTimeOnDay(tomorrow, at);
    },
    event(firedAt, scheduledAt) {
      return dailyReportEvent(localDate(scheduledAt ?? firedAt), firedAt);
    },
  };
}

export const SELF_INITIATIVE_KIND = 'self_initiative';

export function selfInitiativeEntry(options: { everyMinutes: number }): ScheduleEntry {
  const { everyMinutes } = options;
  const interval = Math.max(1, Math.floor(everyMinutes)) * 60_000;

  return {
    kind: SELF_INITIATIVE_KIND,
    description: `${Math.max(1, Math.floor(everyMinutes))} 分ごとに、記憶にある目的から次にやることを決める`,
    nextAt(after) {
      return new Date(after.getTime() + interval);
    },
    event(firedAt) {
      return {
        type: 'self_initiative',
        id: randomUUID(),
        at: firedAt.toISOString(),
        reason: '定期 tick: 記憶にある目的から次にやることを決める',
      };
    },
  };
}

export const MEMORY_TIDY_KIND = 'memory_tidy';

export function memoryTidyEntry(options: { at: TimeOfDay }): ScheduleEntry {
  const { at } = options;
  const label = `${`${at.hour}`.padStart(2, '0')}:${`${at.minute}`.padStart(2, '0')}`;

  return {
    kind: MEMORY_TIDY_KIND,
    description: `毎日 ${label}（ローカル時刻）に記憶の棚卸しをする（大きい文書を割る・古い節を付録へ移す）`,
    // 取りこぼしを拾わない: 掃除は「その時点の状態」への仕事で、後から足すと同じ仕事を2回払うため
    catchUpMissed: false,
    nextAt(after) {
      const today = atTimeOnDay(after, at);
      if (today.getTime() > after.getTime()) return today;
      const tomorrow = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
      return atTimeOnDay(tomorrow, at);
    },
    event(firedAt) {
      // `timer` にしない: `memoryCause` が `'clone'` になり、`guardFullReplace` が素通りして人間が居ない場で記憶を壊せるため
      return {
        type: 'distill',
        id: randomUUID(),
        at: firedAt.toISOString(),
        reason: 'scheduled',
      };
    },
  };
}

// 散文で数え直さない: 別々に書いた散文が配列の更新から取り残されるため
const RESERVED_SCHEDULE_KIND_TUPLE = [
  DAILY_REPORT_KIND,
  SELF_INITIATIVE_KIND,
  MEMORY_TIDY_KIND,
] as const;

export const RESERVED_SCHEDULE_KINDS: readonly string[] = RESERVED_SCHEDULE_KIND_TUPLE;

export type ReservedScheduleKind = (typeof RESERVED_SCHEDULE_KIND_TUPLE)[number];

// daemon 側に置かない: core は daemon に依存できず、断り文言が名前を書き直すことになるため
export const RESERVED_SCHEDULE_KIND_ENV_KEYS: Readonly<Record<ReservedScheduleKind, string>> = {
  [DAILY_REPORT_KIND]: 'ALTEROID_DAILY_REPORT_AT',
  [SELF_INITIATIVE_KIND]: 'ALTEROID_INITIATIVE_EVERY',
  [MEMORY_TIDY_KIND]: 'ALTEROID_MEMORY_TIDY_AT',
};

export function describeReservedScheduleKindEnvKeys(): string {
  return RESERVED_SCHEDULE_KIND_TUPLE.map(
    (kind) => `${kind} は \`${RESERVED_SCHEDULE_KIND_ENV_KEYS[kind]}\``,
  ).join(' / ');
}

const MIDNIGHT: TimeOfDay = { hour: 0, minute: 0 };

export function describeScheduleSpec(spec: ScheduleSpec): string {
  if (spec.type === 'daily') {
    const time = parseTimeOfDay(spec.at);
    const label =
      time === null
        ? spec.at
        : `${`${time.hour}`.padStart(2, '0')}:${`${time.minute}`.padStart(2, '0')}`;
    return `毎日 ${label}（ローカル時刻）`;
  }
  if (spec.type === 'cron') {
    // 読めない式を黙って別の時刻で走らせない: 一覧で壊れていることが分かるようにするため
    return parseCron(spec.expression) === null
      ? `cron: ${spec.expression}（読めないので毎日 00:00 に起こす）`
      : `cron: ${spec.expression}（ローカル時刻）`;
  }
  return `${spec.minutes} 分ごと`;
}

// 依頼の本文をイベントに載せない: 発火時点の写しになり、人間が書き換えても古い本文で走るため
export function scheduledRequestEntry(plan: ScheduledRequest): ScheduleEntry {
  const description = `${describeScheduleSpec(plan.spec)}: ${plan.request.replace(/\s+/g, ' ').trim()}`;

  const spec = plan.spec;

  const dailyAt = (after: Date, at: TimeOfDay): Date => {
    const today = atTimeOnDay(after, at);
    if (today.getTime() > after.getTime()) return today;
    const tomorrow = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
    return atTimeOnDay(tomorrow, at);
  };

  // `after + N分` にしない: 呼ばれた時刻で毎回動き、落ちて起き直したときや手で起こしたときに位相がずれるため
  // 1回ずつ辿って上限で諦める形にしない: 長く止まったときだけ現在時刻基準へ落ちるため（除算で求める）
  const anchor = new Date(plan.createdAt);
  const everyAfter = (after: Date, minutes: number): Date => {
    const interval = Math.max(1, Math.floor(minutes)) * 60_000;
    const base = anchor.getTime();
    if (Number.isNaN(base) || after.getTime() < base) {
      return new Date(after.getTime() + interval);
    }
    const steps = Math.floor((after.getTime() - base) / interval) + 1;
    return new Date(base + steps * interval);
  };

  const nextAt = (after: Date): Date => {
    if (spec.type === 'daily') {
      return dailyAt(after, parseTimeOfDay(spec.at) ?? { hour: 0, minute: 0 });
    }
    if (spec.type === 'cron') {
      return parseCron(spec.expression)?.nextAfter(after) ?? dailyAt(after, MIDNIGHT);
    }
    return everyAfter(after, spec.minutes);
  };

  return {
    kind: plan.kind,
    description,
    nextAt,
    event(firedAt) {
      return {
        type: 'timer',
        id: randomUUID(),
        at: firedAt.toISOString(),
        kind: plan.kind,
      };
    },
  };
}

export interface MissingDailyReportsInput {
  journal: JournalStore;
  at: TimeOfDay;
  now: Date;
  lookbackDays: number;
  scanPageSize?: number;
}

export const MISSING_DAILY_REPORT_SCAN_PAGE_SIZE = 1000;

export async function missingDailyReportDates({
  journal,
  at,
  now,
  lookbackDays,
  scanPageSize = MISSING_DAILY_REPORT_SCAN_PAGE_SIZE,
}: MissingDailyReportsInput): Promise<string[]> {
  const days = Math.max(0, Math.floor(lookbackDays));
  if (days === 0) return [];

  const oldest = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));

  const reported = new Set<string>();
  const active = new Set<string>();
  // `types` で絞らない: `daily_report` 以外のあらゆる種別が「その日に動きがあった」証拠になるため
  let after: JournalQuery['after'];
  for (;;) {
    const { entries: page, next } = await journal.listPage({
      since: oldest.toISOString(),
      order: 'asc',
      limit: scanPageSize,
      ...(after === undefined ? {} : { after }),
    });
    for (const entry of page) {
      if (entry.type === 'daily_report') {
        // 「書けなかった」印の行を日報に数えない: 数えると、その日の本物の日報が二度と書かれないため
        if (isWrittenDailyReport(entry)) reported.add(entry.date);
        continue;
      }
      active.add(localDate(new Date(entry.at)));
    }
    // ページの長さで終端を決めない: store が壊れた行を捨てると、ページが短くても空でも先に行が在りうるため
    if (next === null) break;
    after = next;
  }

  const missing: string[] = [];
  for (let back = days; back >= 0; back -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (atTimeOnDay(day, at).getTime() > now.getTime()) continue;
    const date = localDate(day);
    if (reported.has(date) || !active.has(date)) continue;
    missing.push(date);
  }
  return missing;
}
