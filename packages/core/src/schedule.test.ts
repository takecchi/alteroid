import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  DAILY_REPORT_KIND,
  SELF_INITIATIVE_KIND,
  createScheduler,
  dailyReportEntry,
  localDate,
  localDayRange,
  missingDailyReportDates,
  parseTimeOfDay,
  scheduledRequestEntry,
  selfInitiativeEntry,
} from './schedule.js';

const run = promisify(execFile);
import type { InboxEvent, JournalEntry, ScheduledRequest } from './schema.js';
import type { JournalQuery, JournalStore, ScheduleStore } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 時間起点（PRD「自律」の起点②）と、その上に載る発意 tick（④）。
 *
 * ここで固定したいのは「人間が何も言わなくても仕事が起きる」ことと、その抑止に
 * **回数の上限を持ち込んでいない**ことである（AGENTS.md 地雷2）。
 */

function fakeJournal(entries: JournalEntry[]): JournalStore {
  return {
    async append() {
      throw new Error('このテストでは追記しない');
    },
    async get(id: string) {
      return entries.find((entry) => entry.id === id) ?? null;
    },
    async list(query: JournalQuery = {}) {
      let found = [...entries].sort((a, b) => b.at.localeCompare(a.at));
      if (query.types) found = found.filter((entry) => query.types?.includes(entry.type));
      if (query.since !== undefined) {
        const since = query.since;
        found = found.filter((entry) => entry.at >= since);
      }
      return query.limit === undefined ? found : found.slice(0, query.limit);
    },
  };
}

function at(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('時刻の読み書き', () => {
  it('HH:MM を読む。読めないものは null（呼び出し側が既定へ落とせる）', () => {
    expect(parseTimeOfDay('22:00')).toEqual({ hour: 22, minute: 0 });
    expect(parseTimeOfDay(' 7:05 ')).toEqual({ hour: 7, minute: 5 });
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('22:60')).toBeNull();
    expect(parseTimeOfDay('あさ')).toBeNull();
  });

  it('日報の対象日はローカル日付（人間の一日に合わせる）', () => {
    expect(localDate(at(2026, 8, 12, 23, 30))).toBe('2026-08-12');
    expect(localDate(at(2026, 1, 1, 0, 5))).toBe('2026-01-01');
  });

  it('YYYY-MM-DD からローカル1日ぶんの範囲を作る', () => {
    const range = localDayRange('2026-08-12');
    expect(range?.since).toEqual(at(2026, 8, 12));
    expect(range?.until).toEqual(at(2026, 8, 13));
    expect(localDayRange('2026/08/12')).toBeNull();
  });

  it('存在しない日付は通さない（Date が黙って別の日へ繰り上げるため）', () => {
    expect(localDayRange('2026-02-31')).toBeNull();
    expect(localDayRange('2026-13-01')).toBeNull();
    expect(localDayRange('0000-00-00')).toBeNull();
    // 実在する閏日は通る
    expect(localDayRange('2028-02-29')?.since).toEqual(at(2028, 2, 29));
  });
});

describe('日報の定期ジョブ', () => {
  const entry = dailyReportEntry({ at: { hour: 22, minute: 0 } });

  it('締め時刻の前ならその日、過ぎていたら翌日に起きる', () => {
    expect(entry.nextAt(at(2026, 8, 12, 10, 0))).toEqual(at(2026, 8, 12, 22, 0));
    expect(entry.nextAt(at(2026, 8, 12, 23, 0))).toEqual(at(2026, 8, 13, 22, 0));
    // 締め時刻ちょうどは「もう締めた」と見て次の日へ（同じ発火を二度作らない）
    expect(entry.nextAt(at(2026, 8, 12, 22, 0))).toEqual(at(2026, 8, 13, 22, 0));
  });

  it('対象日をイベントに載せる（発火時刻から逆算させない）', () => {
    const event = entry.event(at(2026, 8, 12, 22, 0));
    expect(event).toMatchObject({ type: 'timer', kind: DAILY_REPORT_KIND, target: '2026-08-12' });
  });
});

describe('発意 tick', () => {
  it('間隔ごとに起き、起点は self_initiative（これが無いものは自律と呼ばない）', () => {
    const entry = selfInitiativeEntry({ everyMinutes: 30 });
    expect(entry.nextAt(at(2026, 8, 12, 10, 0))).toEqual(at(2026, 8, 12, 10, 30));
    expect(entry.event(at(2026, 8, 12, 10, 30))).toMatchObject({ type: 'self_initiative' });
    expect(entry.kind).toBe(SELF_INITIATIVE_KIND);
  });
});

describe('スケジューラ', () => {
  function setup(now: Date) {
    let clock = now;
    const posted: InboxEvent[] = [];
    const scheduler = createScheduler({
      entries: [
        dailyReportEntry({ at: { hour: 22, minute: 0 } }),
        selfInitiativeEntry({ everyMinutes: 60 }),
      ],
      post: (event) => posted.push(event),
      now: () => clock,
    });
    return { posted, scheduler, set: (value: Date) => (clock = value) };
  }

  it('期限が来たものだけを受信箱へ積む', () => {
    const s = setup(at(2026, 8, 12, 10, 0));
    s.scheduler.start();

    expect(s.scheduler.tick(at(2026, 8, 12, 10, 30))).toEqual([]);
    expect(s.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);
    expect(s.scheduler.tick(at(2026, 8, 12, 22, 0))).toEqual([
      DAILY_REPORT_KIND,
      SELF_INITIATIVE_KIND,
    ]);
    expect(s.posted.map((event) => event.type)).toEqual([
      'self_initiative',
      'timer',
      'self_initiative',
    ]);

    s.scheduler.stop();
  });

  it('人間が何も言わなくても起き続ける（回数の上限を持たない）', () => {
    const s = setup(at(2026, 8, 12, 0, 0));
    s.scheduler.start();

    for (let hour = 1; hour <= 12; hour += 1) {
      s.scheduler.tick(at(2026, 8, 12, hour, 0));
    }
    expect(s.posted.filter((event) => event.type === 'self_initiative')).toHaveLength(12);

    s.scheduler.stop();
  });

  it('長く止まっていても、まとめ撃ちせず1回だけ起きる', () => {
    const s = setup(at(2026, 8, 12, 10, 0));
    s.scheduler.start();

    // 3日ぶん寝ていた（ノートを閉じていた等）
    expect(s.scheduler.tick(at(2026, 8, 15, 10, 0))).toEqual([
      DAILY_REPORT_KIND,
      SELF_INITIATIVE_KIND,
    ]);
    expect(s.posted).toHaveLength(2);
    // 次の予定は現在時刻から引き直される
    expect(s.scheduler.tick(at(2026, 8, 15, 10, 1))).toEqual([]);

    s.scheduler.stop();
  });

  it('手で今すぐ起こせる。予定はずらさない', () => {
    const s = setup(at(2026, 8, 12, 10, 0));
    s.scheduler.start();

    expect(s.scheduler.run(DAILY_REPORT_KIND)).toBe(true);
    expect(s.scheduler.run('しらないジョブ')).toBe(false);
    expect(s.posted).toHaveLength(1);
    expect(s.scheduler.list().find((item) => item.kind === DAILY_REPORT_KIND)?.nextAt).toBe(
      at(2026, 8, 12, 22, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('何が仕込まれていて次はいつかが見える（可観測性）', () => {
    const s = setup(at(2026, 8, 12, 10, 0));
    s.scheduler.start();

    expect(s.scheduler.list()).toEqual([
      {
        kind: DAILY_REPORT_KIND,
        description: expect.stringContaining('22:00'),
        nextAt: at(2026, 8, 12, 22, 0).toISOString(),
      },
      {
        kind: SELF_INITIATIVE_KIND,
        description: expect.stringContaining('60 分'),
        nextAt: at(2026, 8, 12, 11, 0).toISOString(),
      },
    ]);

    s.scheduler.stop();
  });
});

/**
 * 既定の仕込み（日報・発意 tick）の位相。
 *
 * ここで守るのは「器を作り直しても発意 tick の位相が失われない」ことである。
 * 位相が失われると、**周期より短い間隔で再デプロイが続くと一度も発火しない**
 * （継続中の依頼については `#firstDue` が塞いでいた穴で、既定の2件だけが
 * ストアに何も持っていなかったために残っていた）。
 */
describe('既定の仕込みの位相', () => {
  function setup(now: Date, options: { store?: ScheduleStore } = {}) {
    let clock = now;
    const posted: InboxEvent[] = [];
    const errors: string[] = [];
    const store = options.store ?? createMemoryStores().schedules;
    const scheduler = createScheduler({
      entries: [
        dailyReportEntry({ at: { hour: 22, minute: 0 } }),
        selfInitiativeEntry({ everyMinutes: 60 }),
      ],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: store,
      onError: (message) => errors.push(message),
    });
    return { posted, errors, scheduler, store, set: (value: Date) => (clock = value) };
  }

  function nextOf(scheduler: { list: () => { kind: string; nextAt: string }[] }, kind: string) {
    return scheduler.list().find((item) => item.kind === kind)?.nextAt;
  }

  it('落ちていた間に過ぎた発意 tick を、起き直したときに1回だけ拾う', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });

    const s = setup(at(2026, 8, 12, 12, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.tick(at(2026, 8, 12, 12, 30))).toEqual([SELF_INITIATIVE_KIND]);
    // まとめ撃ちしない（2時間半ぶん溜まっていても1回）
    expect(s.scheduler.tick(at(2026, 8, 12, 12, 31))).toEqual([]);

    s.scheduler.stop();
  });

  it('周期が過ぎていなければ、再起動しても本来の予定を守る（now + 周期へずれない）', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });

    // 10:30 に起き直した。**位相を捨てると次回が 11:30 になる（これが欠陥だった）。**
    const s = setup(at(2026, 8, 12, 10, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(nextOf(s.scheduler, SELF_INITIATIVE_KIND)).toBe(at(2026, 8, 12, 11, 0).toISOString());
    expect(s.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);

    s.scheduler.stop();
  });

  it('周期より短い間隔で何度起き直しても、本来の期限にちょうど1回発火する', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });

    // 10:20 / 10:40 / 10:55 と3回作り直された（デプロイが続いた）
    for (const minute of [20, 40, 55]) {
      const s = setup(at(2026, 8, 12, 10, minute), { store });
      await s.scheduler.refresh();
      s.scheduler.start();
      expect(s.scheduler.tick(at(2026, 8, 12, 10, minute))).toEqual([]);
      s.scheduler.stop();
    }

    const last = setup(at(2026, 8, 12, 10, 59), { store });
    await last.scheduler.refresh();
    last.scheduler.start();
    expect(last.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);
    last.scheduler.stop();
  });

  it('発火で位相が保存され、次の器がそれを引き継ぐ', async () => {
    const store = createMemoryStores().schedules;
    const first = setup(at(2026, 8, 12, 10, 0), { store });
    await first.scheduler.refresh();
    first.scheduler.start();
    expect(first.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);
    await first.scheduler.settled();
    first.scheduler.stop();

    expect(await store.getPhase(SELF_INITIATIVE_KIND)).toEqual({
      kind: SELF_INITIATIVE_KIND,
      lastRunAt: at(2026, 8, 12, 11, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 12, 11, 0).toISOString(),
    });

    // 11:30 に作り直した器は、12:00（= 11:00 + 60分）を次回にする
    const second = setup(at(2026, 8, 12, 11, 30), { store });
    await second.scheduler.refresh();
    second.scheduler.start();
    expect(nextOf(second.scheduler, SELF_INITIATIVE_KIND)).toBe(
      at(2026, 8, 12, 12, 0).toISOString(),
    );
    second.scheduler.stop();
  });

  it('前回動いた時刻が一覧に出る（再起動しても「まだ一度も動いていない」に見えない）', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastRunAt: at(2026, 8, 12, 10, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });

    const s = setup(at(2026, 8, 12, 10, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.list().find((item) => item.kind === SELF_INITIATIVE_KIND)?.lastRunAt).toBe(
      at(2026, 8, 12, 10, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('手で起こしても定期の基準は動かない（位相がずれない）', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });

    const s = setup(at(2026, 8, 12, 10, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();
    expect(s.scheduler.run(SELF_INITIATIVE_KIND)).toBe(true);
    await s.scheduler.settled();

    expect(await store.getPhase(SELF_INITIATIVE_KIND)).toEqual({
      kind: SELF_INITIATIVE_KIND,
      // 観測用は動く
      lastRunAt: at(2026, 8, 12, 10, 30).toISOString(),
      // 定期の基準は動かない
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });
    expect(nextOf(s.scheduler, SELF_INITIATIVE_KIND)).toBe(at(2026, 8, 12, 11, 0).toISOString());

    s.scheduler.stop();
  });

  it('日報は位相が過ぎていても起き直しで即時発火しない（拾い直しの経路を2つにしない）', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: DAILY_REPORT_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 22, 0).toISOString(),
    });

    // 2日ぶん落ちていた。**日報の後追いは missingDailyReportDates が持っている。**
    const s = setup(at(2026, 8, 14, 10, 0), { store });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(nextOf(s.scheduler, DAILY_REPORT_KIND)).toBe(at(2026, 8, 14, 22, 0).toISOString());
    expect(s.scheduler.tick(at(2026, 8, 14, 10, 0))).not.toContain(DAILY_REPORT_KIND);

    s.scheduler.stop();
  });

  it('位相を保存できなくても時計は止まらず、理由が外へ出る', async () => {
    const store = createMemoryStores().schedules;
    store.putPhase = async () => {
      throw new Error('台帳が書けない');
    };

    const s = setup(at(2026, 8, 12, 10, 0), { store });
    await s.scheduler.refresh();
    s.scheduler.start();
    expect(s.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);
    await s.scheduler.settled();

    expect(s.posted).toHaveLength(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain(SELF_INITIATIVE_KIND);
    expect(s.errors[0]).toContain('台帳が書けない');

    s.scheduler.stop();
  });

  it('位相が保存できなかった後に読み直しても、同じ回を撃ち直さない', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });
    // 保存が落ちるので、ストアの位相は 10:00 のまま古い
    store.putPhase = async () => {
      throw new Error('台帳が書けない');
    };

    const s = setup(at(2026, 8, 12, 10, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();
    expect(s.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);
    await s.scheduler.settled();

    // 刻みごとの読み直し（`#refreshQuietly` と同じ経路）。**ここで位相を読み直すと、
    // 古い 10:00 から数えて「もう過ぎている」と判定し、同じ回を撃ち続ける。**
    await s.scheduler.refresh();
    expect(s.scheduler.tick(at(2026, 8, 12, 11, 1))).toEqual([]);
    expect(s.posted).toHaveLength(1);

    s.scheduler.stop();
  });

  it('位相が読めなくても時計は止まらず、次の読み直しで拾える', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });
    const real = store.getPhase.bind(store);
    let failures = 2;
    store.getPhase = async (kind) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('DB が揺れた');
      }
      return real(kind);
    };

    const s = setup(at(2026, 8, 12, 10, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();
    // 読めなかったので位相は入っていない（既定の `now + 周期` のまま）
    expect(nextOf(s.scheduler, SELF_INITIATIVE_KIND)).toBe(at(2026, 8, 12, 11, 30).toISOString());
    expect(s.errors[0]).toContain('位相を読めなかった');

    // 次の読み直しで拾い直す（一度の瞬断で位相を永久に捨てない）
    await s.scheduler.refresh();
    expect(nextOf(s.scheduler, SELF_INITIATIVE_KIND)).toBe(at(2026, 8, 12, 11, 0).toISOString());

    s.scheduler.stop();
  });

  it('ストアを渡していなければ位相は使わない（既定の仕込みは今までどおり回る）', () => {
    let clock = at(2026, 8, 12, 10, 0);
    const posted: InboxEvent[] = [];
    const scheduler = createScheduler({
      entries: [selfInitiativeEntry({ everyMinutes: 60 })],
      post: (event) => posted.push(event),
      now: () => clock,
    });
    scheduler.start();
    clock = at(2026, 8, 12, 11, 0);
    expect(scheduler.tick()).toEqual([SELF_INITIATIVE_KIND]);
    scheduler.stop();
  });
});

describe('継続中の依頼（時間起点の仕込み）', () => {
  /**
   * 各テストの「いま」。`at()` はローカル時刻を作るので、**仕込んだ時刻もここから
   * 作る**こと。ISO の文字列を直に書くと、実行環境の時差ぶんだけ「過去に仕込まれた
   * 依頼」になり（＝取りこぼしの拾い直しが働き）、CI と手元で結果が変わる。
   */
  const BASE = at(2026, 8, 12, 8, 0);

  const plan = (
    kind: string,
    spec: ScheduledRequest['spec'],
    request = 'GitHub の issue を見て実装を進める',
    createdAt: Date = BASE,
  ): ScheduledRequest => ({
    kind,
    spec,
    request,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  });

  function setup(now: Date) {
    let clock = now;
    const posted: InboxEvent[] = [];
    const stores = createMemoryStores();
    const scheduler = createScheduler({
      entries: [dailyReportEntry({ at: { hour: 22, minute: 0 } })],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    return { posted, scheduler, stores, set: (value: Date) => (clock = value) };
  }

  it('毎日この時刻 / この分数ごと、のどちらでも次の発火が決まる', () => {
    const daily = scheduledRequestEntry(plan('issue-round', { type: 'daily', at: '09:00' }));
    expect(daily.nextAt(at(2026, 8, 12, 8, 0))).toEqual(at(2026, 8, 12, 9, 0));
    // その日の時刻を過ぎていれば翌日
    expect(daily.nextAt(at(2026, 8, 12, 9, 30))).toEqual(at(2026, 8, 13, 9, 0));

    const every = scheduledRequestEntry(plan('watch', { type: 'every', minutes: 30 }));
    expect(every.nextAt(at(2026, 8, 12, 9, 0))).toEqual(at(2026, 8, 12, 9, 30));
  });

  it('cron 式で曜日を指定できる（毎日起きて曜日を見る、をしなくてよい）', () => {
    // 2026-08-12 は水曜。次の月曜 10:00 は 8/17
    const weekly = scheduledRequestEntry(
      plan('weekly-review', { type: 'cron', expression: '0 10 * * 1' }),
    );
    expect(weekly.nextAt(at(2026, 8, 12, 8, 0))).toEqual(at(2026, 8, 17, 10, 0));
    // その月曜の 10:00 を過ぎていれば翌週
    expect(weekly.nextAt(at(2026, 8, 17, 10, 0))).toEqual(at(2026, 8, 24, 10, 0));
    expect(weekly.description).toContain('cron: 0 10 * * 1');

    // 平日だけ、も書ける
    const weekdays = scheduledRequestEntry(
      plan('weekday-check', { type: 'cron', expression: '30 9 * * 1-5' }),
    );
    expect(weekdays.nextAt(at(2026, 8, 14, 10, 0))).toEqual(at(2026, 8, 17, 9, 30)); // 金→月
  });

  it('cron の依頼も、落ちていた間に過ぎた予定を1回だけ拾う', async () => {
    // 2026-08-19（水）に起き直す。前回は 8/10（月）で、8/17（月）の予定を逃している
    const s = setup(at(2026, 8, 19, 12, 0));
    await s.stores.schedules.put({
      ...plan('weekly-review', { type: 'cron', expression: '0 10 * * 1' }),
      lastRunAt: at(2026, 8, 10, 10, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 10, 10, 0).toISOString(),
    });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.tick(at(2026, 8, 19, 12, 0))).toEqual(['weekly-review']);
    expect(s.scheduler.tick(at(2026, 8, 19, 12, 1))).toEqual([]);
    // 拾った後は次の月曜
    expect(s.scheduler.list().find((item) => item.kind === 'weekly-review')?.nextAt).toBe(
      at(2026, 8, 24, 10, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('読めない cron が仕込まれていても沈黙しない（一覧で壊れていると分かる）', () => {
    // 保存の時点で弾いているが、人間がストアを手で直すことはある
    const broken = scheduledRequestEntry(
      plan('broken', { type: 'cron', expression: 'まいにち あさ' }),
    );
    expect(broken.description).toContain('読めない');
    expect(broken.nextAt(at(2026, 8, 12, 8, 0))).toEqual(at(2026, 8, 13, 0, 0));
  });

  it('発火イベントは kind だけを運ぶ（本文は処理する瞬間にストアから読む）', () => {
    const entry = scheduledRequestEntry(plan('issue-round', { type: 'daily', at: '09:00' }));
    const event = entry.event(at(2026, 8, 12, 9, 0));
    expect(event.type).toBe('timer');
    if (event.type !== 'timer') throw new Error('timer ではない');
    expect(event.kind).toBe('issue-round');
    expect(JSON.stringify(event)).not.toContain('issue を見て');
  });

  it('仕込んだ依頼が、次の刻みで時間起点として起きる', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    s.scheduler.start();

    await s.stores.schedules.put(plan('issue-round', { type: 'daily', at: '09:00' }));
    await s.scheduler.refresh();

    expect(s.scheduler.tick(at(2026, 8, 12, 8, 59))).toEqual([]);
    expect(s.scheduler.tick(at(2026, 8, 12, 9, 0))).toEqual(['issue-round']);
    expect(s.posted).toHaveLength(1);

    s.scheduler.stop();
  });

  it('再起動しても `every` の予定が後ろへずれない（依頼自身の時間軸で数える）', async () => {
    // 08:00 に仕込んだ60分ごと。初回は 09:00 のはずで、08:30 に起き直しても動かない
    const s = setup(at(2026, 8, 12, 8, 30));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 60 }));
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('前回実行済みでも、再起動で次回が後ろへずれない', async () => {
    // 09:00 に動いた60分ごとの依頼。09:10 に起き直しても次は 10:00（10:10 ではない）
    const s = setup(at(2026, 8, 12, 9, 10));
    await s.stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      lastRunAt: at(2026, 8, 12, 9, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 12, 9, 0).toISOString(),
    });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 10, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('周期より短い間隔で何度再起動しても、本来の期限にちょうど1回発火する', async () => {
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      createdAt: at(2026, 8, 12, 8, 0).toISOString(),
      updatedAt: at(2026, 8, 12, 8, 0).toISOString(),
    });

    // 10分ごとに器を作り直す（デーモンの再起動）。09:00 を越えるまで一度も発火しない
    for (const minute of [10, 20, 30, 40, 50]) {
      const clock = at(2026, 8, 12, 8, minute);
      const scheduler = createScheduler({
        entries: [],
        post: (event) => posted.push(event),
        now: () => clock,
        schedules: stores.schedules,
      });
      await scheduler.refresh();
      scheduler.start();
      expect(scheduler.tick(clock)).toEqual([]);
      scheduler.stop();
    }
    expect(posted).toEqual([]);

    // 09:00 を迎えた器では、ちょうど1回起きる
    const clock = at(2026, 8, 12, 9, 0);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();
    expect(scheduler.tick(clock)).toEqual(['watch']);
    expect(scheduler.tick(at(2026, 8, 12, 9, 1))).toEqual([]);
    expect(posted).toHaveLength(1);
    scheduler.stop();
  });

  it('未完了の定期発火は、元の時刻の発火として配り直される（位相を復旧時刻へ動かさない）', async () => {
    // 09:00 の定期発火を引き受けたまま器が落ちた状態（claim 済み・未完了）
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      lastRunAt: at(2026, 8, 12, 9, 0).toISOString(),
      pendingRun: { at: at(2026, 8, 12, 9, 0).toISOString(), cause: 'schedule' },
    });

    // 09:30 に起き直す
    const clock = at(2026, 8, 12, 9, 30);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    expect(scheduler.tick(clock)).toEqual(['watch']);
    // **元の発火として**届く（復旧時刻に置き換えない）
    expect(posted.at(-1)).toMatchObject({
      type: 'timer',
      kind: 'watch',
      at: at(2026, 8, 12, 9, 0).toISOString(),
      cause: 'schedule',
    });

    // 受け取った側は、その時刻・その理由で確定させて完了する
    const held = await stores.schedules.get('watch');
    const fired = posted.at(-1);
    if (fired?.type !== 'timer') throw new Error('timer ではない');
    await stores.schedules.claimRun('watch', held?.updatedAt ?? '', fired.at, 'schedule');
    await stores.schedules.completeRun('watch', fired.at, 'schedule');

    // 基準は 09:00 のまま。次回は 10:00（10:30 にずれない）
    expect((await stores.schedules.get('watch'))?.lastScheduledRunAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 10, 0).toISOString(),
    );

    // 同じ回を配り直し続けない
    expect(scheduler.tick(at(2026, 8, 12, 9, 31))).toEqual([]);

    scheduler.stop();
  });

  it('未完了の手動発火を配り直しても、次の定期予定は動かない', async () => {
    // 08:00 仕込みの60分ごと（定期の初回は 09:00）。08:30 に手で起こして未完了のまま落ちた
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      lastRunAt: at(2026, 8, 12, 8, 30).toISOString(),
      pendingRun: { at: at(2026, 8, 12, 8, 30).toISOString(), cause: 'manual' },
    });

    const clock = at(2026, 8, 12, 8, 40);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    expect(scheduler.tick(clock)).toEqual(['watch']);
    expect(posted.at(-1)).toMatchObject({
      at: at(2026, 8, 12, 8, 30).toISOString(),
      cause: 'manual',
    });
    // **定期の予定は 09:00 のまま**（手で起こした1回の時刻から数え直さない）
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    scheduler.stop();
  });

  it('長く止まっていた後の配り直しでも、次回は未来かつ元の位相の上にある', async () => {
    // 09:00 の定期発火が未完了。復旧は 11:30（1周期以上あと）
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      lastRunAt: at(2026, 8, 12, 9, 0).toISOString(),
      pendingRun: { at: at(2026, 8, 12, 9, 0).toISOString(), cause: 'schedule' },
    });

    const clock = at(2026, 8, 12, 11, 30);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    expect(scheduler.tick(clock)).toEqual(['watch']);
    // 次回は元の位相（毎正時）の上で、いまより後の最初 = 12:00
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 12, 0).toISOString(),
    );
    // 過去の時刻を次回に残さない（直後の刻みで余分な発火を続けない）
    expect(scheduler.tick(at(2026, 8, 12, 11, 31))).toEqual([]);
    expect(posted).toHaveLength(1);

    scheduler.stop();
  });

  it('2万周期を超えて止まっていても、次回は元の格子の上にある（走査で諦めない）', async () => {
    // 1分ごとの依頼を、2万分（約14日）より後に復旧する。復旧時刻は格子から30秒ずれている
    const anchor = new Date(2026, 0, 1, 0, 0, 0, 0);
    const clock = new Date(anchor.getTime() + 20_001 * 60_000 + 30_000);
    const expected = new Date(anchor.getTime() + 20_002 * 60_000);

    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 1 }, '見張る', anchor),
      lastRunAt: anchor.toISOString(),
      pendingRun: { at: anchor.toISOString(), cause: 'schedule' },
    });

    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    expect(scheduler.tick(clock)).toEqual(['watch']);
    // 秒・ミリ秒まで元の格子（錨 + 1分の倍数）に乗っている。復旧時刻の30秒ずれを引き継がない
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      expected.toISOString(),
    );
    expect(new Date(expected).getSeconds()).toBe(0);

    scheduler.stop();
  });

  it('cron でも複数回ぶん止まっていた後の次回が、未来かつ元の系列の上にある', async () => {
    // 毎週月曜 10:00。8/10（月）の発火が未完了で、復旧は 8/19（水）
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('weekly-review', { type: 'cron', expression: '0 10 * * 1' }),
      lastRunAt: at(2026, 8, 10, 10, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 3, 10, 0).toISOString(),
      pendingRun: { at: at(2026, 8, 10, 10, 0).toISOString(), cause: 'schedule' },
    });

    const clock = at(2026, 8, 19, 12, 0);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    expect(scheduler.tick(clock)).toEqual(['weekly-review']);
    expect(posted.at(-1)).toMatchObject({ at: at(2026, 8, 10, 10, 0).toISOString() });
    // 次の月曜 10:00（8/24）。過去でも、いまから数え直した 8/26 でもない
    expect(scheduler.list().find((item) => item.kind === 'weekly-review')?.nextAt).toBe(
      at(2026, 8, 24, 10, 0).toISOString(),
    );
    expect(scheduler.tick(at(2026, 8, 19, 12, 1))).toEqual([]);

    scheduler.stop();
  });

  it('未完了の手動発火を配り直しても、定期の基準は動かない', async () => {
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      lastRunAt: at(2026, 8, 12, 9, 10).toISOString(),
      pendingRun: { at: at(2026, 8, 12, 9, 10).toISOString(), cause: 'manual' },
    });

    const clock = at(2026, 8, 12, 9, 30);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    expect(scheduler.tick(clock)).toEqual(['watch']);
    // 手で起こした1回として配り直す（`schedule` に化けさせない）
    expect(posted.at(-1)).toMatchObject({
      type: 'timer',
      at: at(2026, 8, 12, 9, 10).toISOString(),
      cause: 'manual',
    });

    const held = await stores.schedules.get('watch');
    const fired = posted.at(-1);
    if (fired?.type !== 'timer') throw new Error('timer ではない');
    await stores.schedules.claimRun('watch', held?.updatedAt ?? '', fired.at, 'manual');
    await stores.schedules.completeRun('watch', fired.at, 'manual');

    // 定期の基準は動いていない（仕込んだ 08:00 から数えたままである）
    expect((await stores.schedules.get('watch'))?.lastScheduledRunAt).toBeUndefined();

    scheduler.stop();
  });

  it('手で起こしても定期の予定はずれない（再起動を挟んでも）', async () => {
    // 08:00 に仕込んだ60分ごと。本来の予定は 09:00 → 10:00
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put(plan('watch', { type: 'every', minutes: 60 }));

    let clock = at(2026, 8, 12, 9, 0);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();
    // 09:00 の定期発火が予定どおり起きる（受け取った側は定期として確定させる）
    expect(scheduler.tick(clock)).toEqual(['watch']);
    const held = await stores.schedules.get('watch');
    await stores.schedules.claimRun(
      'watch',
      held?.updatedAt ?? '',
      clock.toISOString(),
      'schedule',
    );
    await stores.schedules.completeRun('watch', clock.toISOString(), 'schedule');

    // 09:10 に人間が手で起こす
    clock = at(2026, 8, 12, 9, 10);
    expect(scheduler.run('watch')).toBe(true);
    const manual = posted.at(-1);
    expect(manual).toMatchObject({ type: 'timer', kind: 'watch', cause: 'manual' });
    // 受け取った側（クローン相当）は手動として確定させる
    const beforeManual = await stores.schedules.get('watch');
    await stores.schedules.claimRun(
      'watch',
      beforeManual?.updatedAt ?? '',
      at(2026, 8, 12, 9, 15).toISOString(),
      'manual',
    );
    await stores.schedules.completeRun('watch', at(2026, 8, 12, 9, 15).toISOString(), 'manual');

    // メモリ上の次回は 10:00 のまま
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 10, 0).toISOString(),
    );
    scheduler.stop();

    // 手動実行の時刻は観測用に残るが、定期の基準にはならない
    const after = await stores.schedules.get('watch');
    expect(after?.lastRunAt).toBe(at(2026, 8, 12, 9, 15).toISOString());
    expect(after?.lastScheduledRunAt).toBe(at(2026, 8, 12, 9, 0).toISOString());

    // 09:20 に器を作り直しても次回は 10:00（10:15 にずれない）
    clock = at(2026, 8, 12, 9, 20);
    const restarted = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });
    await restarted.refresh();
    restarted.start();
    expect(restarted.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 10, 0).toISOString(),
    );
    restarted.stop();
  });

  it('一度も定期で動いていない依頼を手で起こしても、初回の予定はずれない', async () => {
    // 08:00 仕込みの60分ごと（初回 09:00）を、08:30 に手で起こす
    const stores = createMemoryStores();
    await stores.schedules.put(plan('watch', { type: 'every', minutes: 60 }));
    const held = await stores.schedules.get('watch');
    await stores.schedules.claimRun(
      'watch',
      held?.updatedAt ?? '',
      at(2026, 8, 12, 8, 30).toISOString(),
      'manual',
    );
    await stores.schedules.completeRun('watch', at(2026, 8, 12, 8, 30).toISOString(), 'manual');

    const clock = at(2026, 8, 12, 8, 40);
    const scheduler = createScheduler({
      entries: [],
      post: () => undefined,
      now: () => clock,
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    scheduler.stop();
  });

  it('未来の日付が入っていても永久に沈黙しない（黙って止まるより遅れて起きる）', async () => {
    // 時計のずれや手編集で createdAt が先の日付になっている場合
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      createdAt: at(2030, 1, 1, 0, 0).toISOString(),
      updatedAt: at(2030, 1, 1, 0, 0).toISOString(),
    });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('周期が同じなら読み直しても予定はずれない（前回時刻だけ新しくなる）', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 30 }));
    await s.scheduler.refresh();
    s.scheduler.start();

    const before = s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt;
    s.set(at(2026, 8, 12, 8, 20));
    const held = await s.stores.schedules.get('watch');
    await s.stores.schedules.claimRun(
      'watch',
      held?.updatedAt ?? '',
      '2026-08-12T08:20:00.000Z',
      'schedule',
    );
    await s.stores.schedules.completeRun('watch', '2026-08-12T08:20:00.000Z', 'schedule');
    await s.scheduler.refresh();

    const after = s.scheduler.list().find((item) => item.kind === 'watch');
    expect(after?.nextAt).toBe(before);
    expect(after?.lastRunAt).toBe('2026-08-12T08:20:00.000Z');
    expect(after?.request).toContain('issue');

    s.scheduler.stop();
  });

  it('周期を変えたら次の発火が引き直される', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 60 }));
    await s.scheduler.refresh();
    s.scheduler.start();
    expect(s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 10 }));
    await s.scheduler.refresh();
    expect(s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 8, 10).toISOString(),
    );

    s.scheduler.stop();
  });

  it('外した依頼はもう起きない', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 10 }));
    await s.scheduler.refresh();
    s.scheduler.start();

    await s.stores.schedules.remove('watch');
    await s.scheduler.refresh();

    expect(s.scheduler.tick(at(2026, 8, 12, 9, 0))).toEqual([]);
    expect(s.scheduler.list().map((item) => item.kind)).toEqual([DAILY_REPORT_KIND]);

    s.scheduler.stop();
  });

  it('既定の定期ジョブと同じ名前では乗っ取れない', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(
      plan(DAILY_REPORT_KIND, { type: 'every', minutes: 1 }, '日報を潰す'),
    );
    await s.scheduler.refresh();
    s.scheduler.start();

    const daily = s.scheduler.list().filter((item) => item.kind === DAILY_REPORT_KIND);
    expect(daily).toHaveLength(1);
    expect(daily[0]?.request).toBeUndefined();
    expect(daily[0]?.nextAt).toBe(at(2026, 8, 12, 22, 0).toISOString());

    s.scheduler.stop();
  });

  it('落ちていた間に過ぎた予定を、起き直したときに1回だけ拾う', async () => {
    // 1日ごとの依頼で、前回動いたのは36時間前。「毎日再起動していたら永久に起きない」
    // を作らないこと（道具は「時刻が来れば必ず届く」と約束している）。
    const s = setup(at(2026, 8, 13, 10, 0));
    await s.stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 1440 }),
      lastRunAt: at(2026, 8, 11, 22, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 11, 22, 0).toISOString(),
    });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.tick(at(2026, 8, 13, 10, 0))).toEqual(['watch']);
    // 拾うのは1回だけ。溜まった回数ぶん撃たない
    expect(s.scheduler.tick(at(2026, 8, 13, 10, 1))).toEqual([]);

    s.scheduler.stop();
  });

  it('仕込んだ直後の依頼はいきなり起きない（拾い直しは取りこぼしのためだけ）', async () => {
    const s = setup(BASE);
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 60 }));
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.tick(BASE)).toEqual([]);
    expect(s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('毎日の依頼は、その日の時刻を過ぎて起き直しても翌日まで飛ばない', async () => {
    const s = setup(at(2026, 8, 13, 9, 30));
    await s.stores.schedules.put({
      ...plan('issue-round', { type: 'daily', at: '09:00' }),
      lastRunAt: at(2026, 8, 12, 9, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 12, 9, 0).toISOString(),
    });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.tick(at(2026, 8, 13, 9, 30))).toEqual(['issue-round']);
    // 拾った後は明日の 09:00
    expect(s.scheduler.list().find((item) => item.kind === 'issue-round')?.nextAt).toBe(
      at(2026, 8, 14, 9, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('今日ぶんが済んでいれば、起き直しても二度は起きない', async () => {
    const s = setup(at(2026, 8, 13, 9, 30));
    await s.stores.schedules.put({
      ...plan('issue-round', { type: 'daily', at: '09:00' }),
      lastRunAt: at(2026, 8, 13, 9, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 13, 9, 0).toISOString(),
    });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.tick(at(2026, 8, 13, 9, 30))).toEqual([]);
    expect(s.scheduler.list().find((item) => item.kind === 'issue-round')?.nextAt).toBe(
      at(2026, 8, 14, 9, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('読み直しが重なっても、外した依頼が復活しない', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 10 }));

    // 「読み始めてから、読み終わる前に外される」を作る
    const first = s.scheduler.refresh();
    await s.stores.schedules.remove('watch');
    const second = s.scheduler.refresh();
    await Promise.all([first, second]);

    expect(s.scheduler.list().map((item) => item.kind)).toEqual([DAILY_REPORT_KIND]);
  });

  it('ストアが読めなくても時計は止まらず、既に仕込んである予定は消えない', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 30 }));
    await s.scheduler.refresh();
    s.scheduler.start();

    s.stores.schedules.list = () => Promise.reject(new Error('DB が揺れた'));
    // 明示的に呼べば失敗は伝わる（握り潰すのはタイマー側だけ）
    await expect(s.scheduler.refresh()).rejects.toThrow('DB が揺れた');

    // それでも仕込みは残っていて、予定どおり起きる
    expect(s.scheduler.tick(at(2026, 8, 12, 8, 30))).toEqual(['watch']);

    s.scheduler.stop();
  });

  it('手で今すぐ起こせる（人間が待たずに確かめる経路も本番と同じ形）', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('issue-round', { type: 'daily', at: '09:00' }));
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.run('issue-round')).toBe(true);
    expect(s.posted).toMatchObject([{ type: 'timer', kind: 'issue-round' }]);
    // 予定はずらさない
    expect(s.scheduler.list().find((item) => item.kind === 'issue-round')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('止めたあとは、読み直しの待ち時間が明けても起こさない', async () => {
    const posted: InboxEvent[] = [];
    const stores = createMemoryStores();
    let clock = at(2026, 8, 12, 8, 0);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });

    await stores.schedules.put(plan('watch', { type: 'every', minutes: 1 }));
    await scheduler.refresh();
    // 予定を過ぎた状態にしてから時計を動かし始める（刻みが即座に来る）
    clock = at(2026, 8, 12, 8, 2);

    // 読み直しが遅い器（pg なら実ネットワーク往復）を模す
    const fast = stores.schedules.list.bind(stores.schedules);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = false;
    stores.schedules.list = async () => {
      reading = true;
      await gate;
      return fast();
    };

    scheduler.start();

    // タイマーの刻みが読み直しの中で止まっているあいだに畳む
    await expect.poll(() => reading, { timeout: 3000 }).toBe(true);
    scheduler.stop();
    release();

    // シャットダウン中に新しいターンが走らないこと（クローンはこの間に最後の蒸留をしている）
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toEqual([]);
  });

  it('ストアを渡していなければ refresh は何もしない（既定の仕込みは回り続ける）', async () => {
    const posted: InboxEvent[] = [];
    const scheduler = createScheduler({
      entries: [selfInitiativeEntry({ everyMinutes: 60 })],
      post: (event) => posted.push(event),
      now: () => at(2026, 8, 12, 8, 0),
    });
    scheduler.start();
    await scheduler.refresh();
    expect(scheduler.tick(at(2026, 8, 12, 9, 0))).toEqual([SELF_INITIATIVE_KIND]);
    scheduler.stop();
  });
});

describe('取りこぼした日報', () => {
  const cutoff = { hour: 22, minute: 0 };

  const entry = (type: 'decision', when: Date): JournalEntry => ({
    type,
    id: `id-${when.toISOString()}`,
    at: when.toISOString(),
    decision: '何かした',
    grounds: '記憶',
  });

  const report = (date: string, when: Date): JournalEntry => ({
    type: 'daily_report',
    id: `report-${date}`,
    at: when.toISOString(),
    date,
    body: '日報',
  });

  it('動いていたのに日報が無い日を、古い順に返す', async () => {
    const journal = fakeJournal([
      entry('decision', at(2026, 8, 10, 15, 0)),
      entry('decision', at(2026, 8, 11, 15, 0)),
      report('2026-08-11', at(2026, 8, 11, 22, 0)),
    ]);

    await expect(
      missingDailyReportDates({ journal, at: cutoff, now: at(2026, 8, 12, 9, 0), lookbackDays: 3 }),
    ).resolves.toEqual(['2026-08-10']);
  });

  it('日誌に何も無い日は対象にしない（空の日報で唯一の層を埋めない）', async () => {
    const journal = fakeJournal([entry('decision', at(2026, 8, 11, 15, 0))]);

    await expect(
      missingDailyReportDates({ journal, at: cutoff, now: at(2026, 8, 12, 9, 0), lookbackDays: 3 }),
    ).resolves.toEqual(['2026-08-11']);
  });

  it('締め時刻を迎えていない今日は、まだ締めない', async () => {
    const journal = fakeJournal([entry('decision', at(2026, 8, 12, 9, 0))]);

    await expect(
      missingDailyReportDates({
        journal,
        at: cutoff,
        now: at(2026, 8, 12, 12, 0),
        lookbackDays: 3,
      }),
    ).resolves.toEqual([]);

    // 締め時刻を過ぎていれば今日も対象になる
    await expect(
      missingDailyReportDates({
        journal,
        at: cutoff,
        now: at(2026, 8, 12, 23, 0),
        lookbackDays: 3,
      }),
    ).resolves.toEqual(['2026-08-12']);
  });

  /**
   * **「書けなかった」の印が付いた行を日報として数えると、後追いが死ぬ。**
   *
   * 上限でターンが死んだ日には `unavailable` の印が付いた行だけが残る
   * （`schema.ts` の doc）。それを日報として数えると、その日は以後この後追いの
   * 対象から永久に外れ、**本物の日報は二度と書かれない**。
   */
  it('unavailable の印が付いた行は日報として数えない（後追いの対象に残す）', async () => {
    const placeholder = (date: string, when: Date): JournalEntry => ({
      type: 'daily_report',
      id: `placeholder-${date}`,
      at: when.toISOString(),
      date,
      body: '（この日の日報は作れなかった。日誌から直接辿ること。理由: …）',
      unavailable: '結果なしで終了: error_during_execution（result_subtype） / 内部で何かが壊れた',
    });

    const journal = fakeJournal([
      entry('decision', at(2026, 8, 10, 15, 0)),
      entry('decision', at(2026, 8, 11, 15, 0)),
      // 10日は印だけ（＝まだ書けていない）、11日は本物。
      placeholder('2026-08-10', at(2026, 8, 10, 22, 0)),
      report('2026-08-11', at(2026, 8, 11, 22, 0)),
    ]);

    await expect(
      missingDailyReportDates({ journal, at: cutoff, now: at(2026, 8, 12, 9, 0), lookbackDays: 3 }),
    ).resolves.toEqual(['2026-08-10']);
  });
});

/**
 * 刻みの中で投げたときの跡（#438 案D）。
 *
 * 直す前、ここには **`catch` が1つも無かった** —— `try/finally` だけだったので、
 * 時計は `finally` で次へ進むのに、**何が起きたかはどこにも残らなかった。**
 *
 * **⚠️ なぜ子プロセスで測るのか。** ここが足した `catch` は跡を残してから
 * **投げ直す**（握り潰さない）。投げ直した先は未処理の拒否になるので、同じプロセスで
 * 走らせると **vitest 自身の unhandled error の歯に必ず引っかかる** —— 実際に一度
 * その形で書いて、`Unhandled Rejection` として報告された。**握り潰さないことが設計
 * なのだから、それを同じプロセスで観測しようとするのが誤りである。**
 *
 * `dist` を読む理由と、`src` だけ直して build しないと古い `dist` に緑が出る話は
 * `uncaught-net.test.ts` の同型のテストに在る。
 */
describe('刻みの中で投げたとき（#438）', () => {
  it('跡を残してから投げ直す（握り潰さない）', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = join(here, '..', 'dist', 'index.js');
    // **必ず期限が来ている仕込みを渡す。** 既定の仕込み（日報・発意）だと最初の
    // 発火まで実時間で待つことになり、テストが時間切れになる（実際に一度なった）。
    const child = [
      `import { createScheduler } from ${JSON.stringify(entry)};`,
      `const clock = new Date('2026-08-12T22:00:00');`,
      `const scheduler = createScheduler({`,
      `  entries: [{`,
      `    kind: 'probe',`,
      `    description: 'probe',`,
      `    nextAt: (after) => after,`,
      `    event: (at) => ({ id: 'e1', at: at.toISOString(), type: 'timer', kind: 'probe' }),`,
      `  }],`,
      `  post: () => { throw new Error('受信箱が投げた'); },`,
      `  now: () => clock,`,
      `});`,
      `scheduler.start();`,
    ].join('\n');

    const failure = await run(process.execPath, ['--input-type=module', '-e', child]).then(
      () => null,
      (error: unknown) => error as { code?: number; stderr?: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(1);

    const stderr = failure?.stderr ?? '';
    // 跡が「どこで」を名指しする。
    expect(stderr).toContain('仕込みの刻みが例外で終わりました');
    // **握り潰していない** —— Node 既定のスタックがそのまま続く。
    expect(stderr).toContain('受信箱が投げた');
    expect(stderr).toMatch(/\n\s+at /u);
  });
});
