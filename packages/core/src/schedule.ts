import { randomUUID } from 'node:crypto';

import type { InboxEvent } from './schema.js';
import type { JournalStore } from './store.js';

/**
 * スケジューラ — 時間起点のジョブ（PRD「自律」の起点②）。
 *
 * 仕事の起点は人間に限らない。ここが人間の不在を埋める側の入口であり、
 * 発火は必ず**クローンの受信箱**へ積む。受信箱を迂回して直接ターンを起こすと、
 * 走行中のターンを踏み潰す（clone.ts の「ターンの起動口は受信箱ただ1つ」）。
 *
 * ここは能力の削除を持ち込みたくなる場所でもある。**実行回数の上限や
 * 「連続で N 回までしか起こさない」といった抑止を置かないこと**（AGENTS.md 地雷2）。
 * 間隔は方針であり設定で開けられるが、走り続ける前提そのものは動かさない。
 */

/** 定期ジョブ1件。次の発火時刻と、そのとき受信箱へ積むイベントだけを知っている。 */
export interface ScheduleEntry {
  /** 一意の名前。人間が `/schedule` や HTTP から手で起こすときの識別子でもある。 */
  kind: string;
  /** 人間向けの説明。 */
  description: string;
  /** `after` より後の最初の発火時刻。 */
  nextAt(after: Date): Date;
  /** 発火時に受信箱へ積むイベント。 */
  event(at: Date): InboxEvent;
}

export interface ScheduleStatus {
  kind: string;
  description: string;
  /** 次の発火時刻（ISO 8601）。 */
  nextAt: string;
}

export interface Scheduler {
  /** 時計を動かし始める。 */
  start(): void;
  stop(): void;
  /** 何が仕込まれていて、次はいつ起きるか（可観測性）。 */
  list(): ScheduleStatus[];
  /**
   * 定期ジョブを今すぐ起こす。定期の予定はずらさない（予定に代えて割り込むのでは
   * なく、余分に1回起こす）。知らない kind なら false。
   */
  run(kind: string): boolean;
  /** 期限が来たものを起こす。内部タイマーとテストの共通経路。 */
  tick(now?: Date): string[];
}

export interface SchedulerOptions {
  entries: ScheduleEntry[];
  /** 受信箱へ積む口。 */
  post: (event: InboxEvent) => void;
  /** 主にテスト用。 */
  now?: () => Date;
}

/**
 * 見張りの間隔の上限。
 *
 * 次の発火が半日先でも、待ち方は最大この間隔で刻む。長い `setTimeout` 1本に
 * 賭けると、蓋を閉じたノートを開いた後や時計が飛んだ後に予定が黙って腐る
 * （常駐は自律の前提なので、そこで止まるのは要件違反になる）。
 */
const MAX_SLEEP_MS = 60_000;

export function createScheduler(options: SchedulerOptions): Scheduler {
  return new TimerScheduler(options);
}

class TimerScheduler implements Scheduler {
  readonly #entries: ScheduleEntry[];
  readonly #post: (event: InboxEvent) => void;
  readonly #now: () => Date;
  readonly #due = new Map<string, number>();

  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  constructor({ entries, post, now }: SchedulerOptions) {
    this.#entries = entries;
    this.#post = post;
    this.#now = now ?? (() => new Date());
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const now = this.#now();
    for (const entry of this.#entries) {
      this.#due.set(entry.kind, entry.nextAt(now).getTime());
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
    return this.#entries.map((entry) => ({
      kind: entry.kind,
      description: entry.description,
      nextAt: new Date(this.#due.get(entry.kind) ?? entry.nextAt(now).getTime()).toISOString(),
    }));
  }

  run(kind: string): boolean {
    const entry = this.#entries.find((candidate) => candidate.kind === kind);
    if (!entry) return false;
    this.#post(entry.event(this.#now()));
    return true;
  }

  tick(now: Date = this.#now()): string[] {
    const fired: string[] = [];
    for (const entry of this.#entries) {
      const due = this.#due.get(entry.kind);
      if (due === undefined || due > now.getTime()) continue;
      // 次の予定を先に決める。イベント投入で例外が出ても、同じ発火を
      // 取りこぼしなく繰り返し続ける（＝暴走する）ことがないように。
      this.#due.set(entry.kind, entry.nextAt(now).getTime());
      fired.push(entry.kind);
      this.#post(entry.event(now));
    }
    return fired;
  }

  #arm(): void {
    if (!this.#started) return;
    if (this.#timer !== null) clearTimeout(this.#timer);

    const now = this.#now().getTime();
    const next = Math.min(...[...this.#due.values()], now + MAX_SLEEP_MS);
    const delay = Math.min(Math.max(next - now, 0), MAX_SLEEP_MS);

    this.#timer = setTimeout(() => {
      this.#timer = null;
      try {
        this.tick();
      } finally {
        this.#arm();
      }
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// 定期ジョブの実例
// ---------------------------------------------------------------------------

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** `HH:MM` を読む。読めなければ null（呼び出し側が既定値へ落とす）。 */
export function parseTimeOfDay(value: string): TimeOfDay | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** ローカル時刻での `YYYY-MM-DD`。日報の対象日は人間の一日に合わせる。 */
export function localDate(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** ローカル時刻でのその日の 00:00。 */
export function startOfLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, 0);
}

/**
 * `YYYY-MM-DD` のローカル1日ぶんの範囲。読めない・存在しない日付なら null。
 *
 * **形だけ見て通してはいけない。** `Date` は `2026-02-31` や `0000-00-00` を黙って
 * 別の日に繰り上げ／繰り下げるので、そのまま日報の対象日や検索範囲に使うと、
 * 書いた日と読める日がずれる（人間が読もうとして読めない = 可観測性のバグ）。
 */
export function localDayRange(date: string): { since: Date; until: Date } | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const since = new Date(year, month, day, 0, 0, 0, 0);
  // 繰り上がっていれば、その日付は存在しない
  if (localDate(since) !== date) return null;
  return { since, until: new Date(year, month, day + 1, 0, 0, 0, 0) };
}

function atTimeOnDay(day: Date, time: TimeOfDay): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
}

/** 日報の発火イベント。対象日を運ぶのはここ1箇所に寄せる（後追いの生成でも同じ形）。 */
export function dailyReportEvent(target: string, at: Date = new Date()): InboxEvent {
  return {
    type: 'timer',
    id: randomUUID(),
    at: at.toISOString(),
    kind: DAILY_REPORT_KIND,
    target,
  };
}

export const DAILY_REPORT_KIND = 'daily_report';

/**
 * 日報 — 時間起点ジョブの最初の実例（PRD「可観測性」）。
 *
 * 1日の終わりに、その日を締める。締め時刻に発火し、対象日は**発火時刻の
 * ローカル日付**である。
 */
export function dailyReportEntry(options: { at: TimeOfDay }): ScheduleEntry {
  const { at } = options;
  const label = `${`${at.hour}`.padStart(2, '0')}:${`${at.minute}`.padStart(2, '0')}`;

  return {
    kind: DAILY_REPORT_KIND,
    description: `毎日 ${label}（ローカル時刻）にその日の日報をまとめる`,
    nextAt(after) {
      const today = atTimeOnDay(after, at);
      if (today.getTime() > after.getTime()) return today;
      const tomorrow = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
      return atTimeOnDay(tomorrow, at);
    },
    event(firedAt) {
      return dailyReportEvent(localDate(firedAt), firedAt);
    },
  };
}

export const SELF_INITIATIVE_KIND = 'self_initiative';

/**
 * クローンの発意 — 起点④（PRD「自律」）。
 *
 * これが無いものは自律とは呼ばない。「何もしない」という結論も含めて、
 * 次にやることを決めるのはクローンであって、ここではない。
 */
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

// ---------------------------------------------------------------------------
// 取りこぼした日報の後追い
// ---------------------------------------------------------------------------

export interface MissingDailyReportsInput {
  journal: JournalStore;
  /** 締め時刻。この時刻を過ぎた日だけが「締められる日」である。 */
  at: TimeOfDay;
  now: Date;
  /** 何日前まで遡って探すか。 */
  lookbackDays: number;
}

/**
 * 日報が無いまま過ぎた日を探す（古い順）。
 *
 * デーモンが締め時刻に動いていなければ、その日の日報は誰も作らない。「日報が毎日
 * 生成される」は受け入れ基準なので、起動時にここで拾い直す。
 *
 * **日誌に何も無い日は対象にしない。** 動いていなかった日に空の日報を積むのは、
 * 人間が読む唯一の層をノイズで埋めることにしかならない。
 */
export async function missingDailyReportDates({
  journal,
  at,
  now,
  lookbackDays,
}: MissingDailyReportsInput): Promise<string[]> {
  const days = Math.max(0, Math.floor(lookbackDays));
  if (days === 0) return [];

  const oldest = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
  const entries = await journal.list({ since: oldest.toISOString() });

  const reported = new Set<string>();
  const active = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'daily_report') {
      reported.add(entry.date);
      continue;
    }
    active.add(localDate(new Date(entry.at)));
  }

  const missing: string[] = [];
  for (let back = days; back >= 0; back -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    // 締め時刻を迎えていない日はまだ締められない（今日は大抵ここで外れる）
    if (atTimeOnDay(day, at).getTime() > now.getTime()) continue;
    const date = localDate(day);
    if (reported.has(date) || !active.has(date)) continue;
    missing.push(date);
  }
  return missing;
}
