import { randomUUID } from 'node:crypto';

import { parseCron } from './cron.js';
import type { InboxEvent, ScheduleSpec, ScheduledRequest } from './schema.js';
import type { JournalStore, ScheduleStore } from './store.js';

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
  /** 定期の依頼として仕込まれたものだけ（既定の日報・発意には無い）。 */
  request?: string;
  /** 前回この kind で発火した時刻。 */
  lastRunAt?: string;
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
  /**
   * 永続化された「定期の依頼」を読み直して、仕込みを合わせる。
   *
   * **クローンや人間が依頼を足す経路をここへ通す。** スケジューラへ直接 add する
   * 口を作ると、器（ストア）と仕込み（メモリ）の二重管理になり、デーモンを
   * 再起動した瞬間に依頼が消える。真実はストア側だけに置く。
   */
  refresh(): Promise<void>;
}

export interface SchedulerOptions {
  /** 既定で仕込むもの（日報・発意）。設定で外せるが、依頼で置き換わるものではない。 */
  entries: ScheduleEntry[];
  /** 受信箱へ積む口。 */
  post: (event: InboxEvent) => void;
  /** 主にテスト用。 */
  now?: () => Date;
  /**
   * 継続中の依頼の置き場。渡さなければ既定の定期ジョブだけが回る
   * （`refresh()` は何もしない）。
   */
  schedules?: ScheduleStore;
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
  /** 既定の仕込み（日報・発意）。 */
  readonly #base: ScheduleEntry[];
  /** 継続中の依頼から作った仕込み。ストアを読み直すたびに合わせ直す。 */
  readonly #requests = new Map<
    string,
    { entry: ScheduleEntry; spec: string; plan: ScheduledRequest }
  >();
  readonly #post: (event: InboxEvent) => void;
  readonly #now: () => Date;
  readonly #store: ScheduleStore | undefined;
  readonly #due = new Map<string, number>();

  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  /** 走行中の読み直し。重ねずに直列に流すための鎖。 */
  #refreshing: Promise<void> | null = null;

  constructor({ entries, post, now, schedules }: SchedulerOptions) {
    this.#base = entries;
    this.#post = post;
    this.#now = now ?? (() => new Date());
    this.#store = schedules;
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
      return {
        kind: entry.kind,
        description: entry.description,
        nextAt: new Date(this.#due.get(entry.kind) ?? entry.nextAt(now).getTime()).toISOString(),
        ...(plan === undefined ? {} : { request: plan.request }),
        ...(plan?.lastRunAt === undefined ? {} : { lastRunAt: plan.lastRunAt }),
      };
    });
  }

  run(kind: string): boolean {
    const entry = this.#entries().find((candidate) => candidate.kind === kind);
    if (!entry) return false;
    this.#post(entry.event(this.#now()));
    return true;
  }

  /**
   * 読み直しは**直列**にする。
   *
   * タイマーの刻みと、人間が API から足した／外した直後の読み直しは必ず重なりうる。
   * 並行に走らせると、先に読み始めた側が古い一覧で `#requests` を上書きし、
   * 外したはずの依頼が復活する（＝外したと言われた依頼がもう一度起きる）。
   */
  refresh(): Promise<void> {
    const run = (this.#refreshing ?? Promise.resolve()).then(() => this.#reconcile());
    this.#refreshing = run.catch(() => undefined);
    return run;
  }

  async #reconcile(): Promise<void> {
    if (this.#store === undefined) return;
    const plans = await this.#store.list();
    const now = this.#now();
    const seen = new Set<string>();

    for (const plan of plans) {
      // 既定の仕込みと同じ名前は乗っ取らせない（日報を「定期の依頼」で潰せてしまう）
      if (this.#base.some((entry) => entry.kind === plan.kind)) continue;
      seen.add(plan.kind);
      const spec = JSON.stringify(plan.spec);
      const existing = this.#requests.get(plan.kind);
      if (existing?.spec === spec) {
        // 周期が同じなら次の予定はずらさない。lastRunAt だけ新しくする
        existing.plan = plan;
        continue;
      }
      const entry = scheduledRequestEntry(plan);
      this.#requests.set(plan.kind, { entry, spec, plan });
      this.#due.set(plan.kind, this.#firstDue(entry, plan, now).getTime());
    }

    for (const kind of [...this.#requests.keys()]) {
      if (seen.has(kind)) continue;
      this.#requests.delete(kind);
      this.#due.delete(kind);
    }

    // 仕込みが増えたなら、次の見張りをその予定に合わせ直す
    this.#arm();
  }

  /**
   * 依頼自身の時間軸で次の予定を決める。**現在時刻を基準にしない。**
   *
   * 予定は「前回動いた時刻（無ければ仕込んだ時刻）から数えた次」である。ここを
   * `now` から数え直すと2つ壊れる。
   *
   * 1. **`every` が再起動のたびに後ろへずれる。** 08:00 に仕込んだ60分ごとの依頼は
   *    09:00 が初回だが、08:30 に起き直した瞬間に 09:30 へ動く。周期より短い間隔で
   *    再起動していれば**一度も発火しない**（`/run` で `lastRunAt` が付いた後も同じ）
   * 2. 手で起こしても「定期の予定はずらさない」という `run()` の約束が崩れる
   *
   * 逆に、その予定が既に過ぎているなら落ちていた間に取りこぼしているので、いま
   * 起こす。日報の後追い（`missingDailyReportDates`）と同じ考え方で、**1回だけ**拾う
   * （溜まった回数ぶん撃たない）。
   */
  #firstDue(entry: ScheduleEntry, plan: ScheduledRequest, now: Date): Date {
    const seed = new Date(plan.lastRunAt ?? plan.createdAt);
    if (Number.isNaN(seed.getTime())) return entry.nextAt(now);

    const fromSeed = entry.nextAt(seed);
    // 過ぎている = 落ちていた間に取りこぼした
    if (fromSeed.getTime() <= now.getTime()) return now;
    // まだ来ていない = 本来の予定をそのまま守る。ただし、時計のずれや人為的に
    // 未来の日付が入った場合に永久に沈黙しないよう、現在時刻から数えた次より
    // 後ろにはしない（黙って止まるより遅れて起きる方がよい）。
    return new Date(Math.min(fromSeed.getTime(), entry.nextAt(now).getTime()));
  }

  #entries(): ScheduleEntry[] {
    return [...this.#base, ...[...this.#requests.values()].map((held) => held.entry)];
  }

  tick(now: Date = this.#now()): string[] {
    const fired: string[] = [];
    for (const entry of this.#entries()) {
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
      void (async () => {
        try {
          // 依頼が増減していればこの刻みで拾う。仕込みの真実はストア側にしか無い
          // ので、ここを通らないと「足したのに起きない」が起きる。
          await this.#refreshQuietly();
          // **待っている間に止められていたら、もう起こさない。** ここを見ないと
          // シャットダウン中（クローンが最後の蒸留をしている間）に新しいターンが
          // 走り、マネージャーまで起きうる。
          if (!this.#started) return;
          this.tick();
        } finally {
          this.#arm();
        }
      })();
    }, delay);
  }

  /**
   * 記憶の器の瞬断で時計を止めない。
   *
   * 読めなかったときに既に仕込んである予定を捨てないこと（捨てると、DB が
   * 一瞬揺れただけで継続中の依頼が黙って消える）。
   */
  async #refreshQuietly(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // 次の刻みで読み直す
    }
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
// 継続中の依頼（クローンと人間が後から仕込む時間起点）
// ---------------------------------------------------------------------------

/** 既定の仕込みの名前。依頼で乗っ取らせない。 */
export const RESERVED_SCHEDULE_KINDS: readonly string[] = [DAILY_REPORT_KIND, SELF_INITIATIVE_KIND];

/** 読めない指定を落とす先（沈黙させないため）。 */
const MIDNIGHT: TimeOfDay = { hour: 0, minute: 0 };

/** 人間が `/schedule` で読む周期の言い方。 */
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
    // 読めない式は保存できないが、人間が手でストアを直すことはある。**黙って
    // 別の時刻で走らせない** — 一覧で壊れていることが分かるようにする。
    return parseCron(spec.expression) === null
      ? `cron: ${spec.expression}（読めないので毎日 00:00 に起こす）`
      : `cron: ${spec.expression}（ローカル時刻）`;
  }
  return `${spec.minutes} 分ごと`;
}

/**
 * 継続中の依頼1件を仕込みに変える。
 *
 * **依頼の本文をイベントに載せない。** 受信箱に載せた瞬間に、それは発火した時点の
 * 写しになる（人間が依頼を書き換えても古い本文で走る）。運ぶのは `kind` だけで、
 * 本文はクローンが処理する瞬間にストアから読む。
 */
export function scheduledRequestEntry(plan: ScheduledRequest): ScheduleEntry {
  const description = `${describeScheduleSpec(plan.spec)}: ${plan.request.replace(/\s+/g, ' ').trim()}`;

  const spec = plan.spec;

  /**
   * 読めない指定で沈黙させないための最後の砦。
   *
   * 保存の時点で弾いているので通常は来ないが、人間がストアを手で直すことはある。
   * **黙って止まるより、毎日 00:00 に起こして一覧で壊れていると見せる**
   * （`describeScheduleSpec` がその旨を書く）。
   */
  const dailyAt = (after: Date, at: TimeOfDay): Date => {
    const today = atTimeOnDay(after, at);
    if (today.getTime() > after.getTime()) return today;
    const tomorrow = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
    return atTimeOnDay(tomorrow, at);
  };

  const nextAt = (after: Date): Date => {
    if (spec.type === 'daily') {
      return dailyAt(after, parseTimeOfDay(spec.at) ?? { hour: 0, minute: 0 });
    }
    if (spec.type === 'cron') {
      // croner はローカル時刻で、`after` より後の最初の時刻を返す
      return parseCron(spec.expression)?.nextAfter(after) ?? dailyAt(after, MIDNIGHT);
    }
    return new Date(after.getTime() + Math.max(1, Math.floor(spec.minutes)) * 60_000);
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
