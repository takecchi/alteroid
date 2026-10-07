import { describe, expect, it } from 'vitest';

import { runChildAgainstSrc, siblingSrcPath } from './child-src.test-support.js';
import {
  DAILY_REPORT_KIND,
  SELF_INITIATIVE_KIND,
  createScheduler,
  dailyReportEntry,
  localDate,
  localDayRange,
  missingDailyReportDates,
  MISSING_DAILY_REPORT_SCAN_PAGE_SIZE,
  parseTimeOfDay,
  scheduledRequestEntry,
  selfInitiativeEntry,
  MEMORY_TIDY_KIND,
  RESERVED_SCHEDULE_KINDS,
  memoryTidyEntry,
} from './schedule.js';
import type { InboxEvent, JournalEntry, ScheduledRequest } from './schema.js';
import { JournalAnchorNotFoundError, describeUnreadableSchedules } from './store.js';
import type { JournalQuery, JournalStore, ScheduleStore } from './store.js';
import { listPageByOverfetch } from './journal-page.js';
import { createMemoryStores } from './testing.js';

function fakeJournal(entries: JournalEntry[]): JournalStore {
  const journal: JournalStore = {
    async append() {
      throw new Error('このテストでは追記しない');
    },
    async get(id: string) {
      return entries.find((entry) => entry.id === id) ?? null;
    },
    async list(query: JournalQuery = {}) {
      let pool = entries;
      if (query.types) {
        const types = query.types;
        pool = pool.filter((entry) => types.includes(entry.type));
      }
      if (query.since !== undefined) {
        const since = query.since;
        pool = pool.filter((entry) => entry.at >= since);
      }
      if (query.until !== undefined) {
        const until = query.until;
        pool = pool.filter((entry) => entry.at <= until);
      }
      const desc = [...pool].sort((a, b) => b.at.localeCompare(a.at));
      const ordered = query.order === 'asc' ? [...desc].reverse() : desc;
      let windowed = ordered;
      if (query.after !== undefined) {
        const anchor = query.after;
        const idx = ordered.findIndex((entry) => entry.id === anchor.id && entry.at === anchor.at);
        if (idx === -1) {
          throw new JournalAnchorNotFoundError(
            `fakeJournal: after で指定された行（id=${anchor.id}, at=${anchor.at}）が見つからない`,
          );
        }
        windowed = ordered.slice(idx + 1);
      }
      return query.limit === undefined ? windowed : windowed.slice(0, query.limit);
    },
    async listPage(query: JournalQuery = {}) {
      return listPageByOverfetch(journal, query);
    },
    async oldestAt() {
      throw new Error('このテストでは使わない');
    },
    async clear() {
      throw new Error('このテストでは消さない');
    },
  };
  return journal;
}

function droppingAfterLimit(
  inner: JournalStore,
  isBroken: (e: JournalEntry) => boolean,
): JournalStore {
  return {
    ...inner,
    list: async (query) => (await inner.list(query)).filter((e) => !isBroken(e)),
    listPage: async (query) => {
      const page = await inner.listPage(query);
      return { entries: page.entries.filter((e) => !isBroken(e)), next: page.next };
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
    expect(localDayRange('2028-02-29')?.since).toEqual(at(2028, 2, 29));
  });
});

describe('日報の定期ジョブ', () => {
  const entry = dailyReportEntry({ at: { hour: 22, minute: 0 } });

  it('締め時刻の前ならその日、過ぎていたら翌日に起きる', () => {
    expect(entry.nextAt(at(2026, 8, 12, 10, 0))).toEqual(at(2026, 8, 12, 22, 0));
    expect(entry.nextAt(at(2026, 8, 12, 23, 0))).toEqual(at(2026, 8, 13, 22, 0));
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

    expect(s.scheduler.tick(at(2026, 8, 15, 10, 0))).toEqual([
      DAILY_REPORT_KIND,
      SELF_INITIATIVE_KIND,
    ]);
    expect(s.posted).toHaveLength(2);
    expect(s.scheduler.tick(at(2026, 8, 15, 10, 1))).toEqual([]);

    s.scheduler.stop();
  });

  it('D 日 22:00 をまたいで止まり D+1 日 08:00 に再開しても、対象日は止まっていた D 日になる（#2740）', () => {
    const s = setup(at(2026, 8, 12, 10, 0));
    s.scheduler.start();

    s.scheduler.tick(at(2026, 8, 13, 8, 0));
    const targets = () =>
      s.posted.flatMap((event) =>
        event.type === 'timer' && event.kind === DAILY_REPORT_KIND ? [event.target] : [],
      );
    expect(targets()).toEqual(['2026-08-12']);

    s.scheduler.tick(at(2026, 8, 13, 22, 0));
    expect(targets()).toEqual(['2026-08-12', '2026-08-13']);

    s.scheduler.stop();
  });

  it('複数日止まっていたときも、予定時刻（due）の日付で1回だけ立つ（まとめ撃ちしない）', () => {
    const s = setup(at(2026, 8, 12, 10, 0));
    s.scheduler.start();

    s.scheduler.tick(at(2026, 8, 15, 10, 0));
    const reports = s.posted.filter(
      (event) => event.type === 'timer' && event.kind === DAILY_REPORT_KIND,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ target: '2026-08-12' });

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
    expect(s.posted[0]).toMatchObject({ type: 'self_initiative', cause: 'schedule_catchup' });
    expect(s.scheduler.tick(at(2026, 8, 12, 12, 31))).toEqual([]);

    s.scheduler.stop();
  });

  it('周期が過ぎていなければ、再起動しても本来の予定を守る（now + 周期へずれない）', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });

    const s = setup(at(2026, 8, 12, 10, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(nextOf(s.scheduler, SELF_INITIATIVE_KIND)).toBe(at(2026, 8, 12, 11, 0).toISOString());
    expect(s.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);
    expect(s.posted[0]).not.toHaveProperty('cause');

    s.scheduler.stop();
  });

  it('周期より短い間隔で何度起き直しても、本来の期限にちょうど1回発火する', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: SELF_INITIATIVE_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });

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
      lastRunAt: at(2026, 8, 12, 10, 30).toISOString(),
      lastScheduledRunAt: at(2026, 8, 12, 10, 0).toISOString(),
    });
    expect(nextOf(s.scheduler, SELF_INITIATIVE_KIND)).toBe(at(2026, 8, 12, 11, 0).toISOString());
    expect(s.posted[0]).toMatchObject({ type: 'self_initiative', cause: 'manual' });

    s.scheduler.stop();
  });

  it('日報は位相が過ぎていても起き直しで即時発火しない（拾い直しの経路を2つにしない）', async () => {
    const store = createMemoryStores().schedules;
    await store.putPhase({
      kind: DAILY_REPORT_KIND,
      lastScheduledRunAt: at(2026, 8, 12, 22, 0).toISOString(),
    });

    const s = setup(at(2026, 8, 14, 10, 0), { store });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(nextOf(s.scheduler, DAILY_REPORT_KIND)).toBe(at(2026, 8, 14, 22, 0).toISOString());
    expect(s.scheduler.tick(at(2026, 8, 14, 10, 0))).not.toContain(DAILY_REPORT_KIND);

    expect(s.scheduler.tick(at(2026, 8, 14, 22, 0))).toContain(DAILY_REPORT_KIND);
    const dailyReportPosted = s.posted.filter(
      (event) => event.type === 'timer' && event.kind === DAILY_REPORT_KIND,
    );
    expect(dailyReportPosted).toHaveLength(1);
    expect(dailyReportPosted[0]).not.toHaveProperty('cause');

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
    store.putPhase = async () => {
      throw new Error('台帳が書けない');
    };

    const s = setup(at(2026, 8, 12, 10, 30), { store });
    await s.scheduler.refresh();
    s.scheduler.start();
    expect(s.scheduler.tick(at(2026, 8, 12, 11, 0))).toEqual([SELF_INITIATIVE_KIND]);
    await s.scheduler.settled();

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
    expect(nextOf(s.scheduler, SELF_INITIATIVE_KIND)).toBe(at(2026, 8, 12, 11, 30).toISOString());
    expect(s.errors[0]).toContain('位相を読めなかった');

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
  // ISO の文字列を直に書かない: 時差ぶんだけ「過去に仕込まれた依頼」になり、CI と手元で結果が変わるため
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
    expect(daily.nextAt(at(2026, 8, 12, 9, 30))).toEqual(at(2026, 8, 13, 9, 0));

    const every = scheduledRequestEntry(plan('watch', { type: 'every', minutes: 30 }));
    expect(every.nextAt(at(2026, 8, 12, 9, 0))).toEqual(at(2026, 8, 12, 9, 30));
  });

  it('cron 式で曜日を指定できる（毎日起きて曜日を見る、をしなくてよい）', () => {
    const weekly = scheduledRequestEntry(
      plan('weekly-review', { type: 'cron', expression: '0 10 * * 1' }),
    );
    expect(weekly.nextAt(at(2026, 8, 12, 8, 0))).toEqual(at(2026, 8, 17, 10, 0));
    expect(weekly.nextAt(at(2026, 8, 17, 10, 0))).toEqual(at(2026, 8, 24, 10, 0));
    expect(weekly.description).toContain('cron: 0 10 * * 1');

    const weekdays = scheduledRequestEntry(
      plan('weekday-check', { type: 'cron', expression: '30 9 * * 1-5' }),
    );
    expect(weekdays.nextAt(at(2026, 8, 14, 10, 0))).toEqual(at(2026, 8, 17, 9, 30));
  });

  it('cron の依頼も、落ちていた間に過ぎた予定を1回だけ拾う', async () => {
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
    expect(s.scheduler.list().find((item) => item.kind === 'weekly-review')?.nextAt).toBe(
      at(2026, 8, 24, 10, 0).toISOString(),
    );

    s.scheduler.stop();
  });

  it('読めない cron が仕込まれていても沈黙しない（一覧で壊れていると分かる）', () => {
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
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      lastRunAt: at(2026, 8, 12, 9, 0).toISOString(),
      pendingRun: { at: at(2026, 8, 12, 9, 0).toISOString(), cause: 'schedule' },
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
    expect(posted.at(-1)).toMatchObject({
      type: 'timer',
      kind: 'watch',
      at: at(2026, 8, 12, 9, 0).toISOString(),
      cause: 'schedule',
    });

    const held = await stores.schedules.get('watch');
    const fired = posted.at(-1);
    if (fired?.type !== 'timer') throw new Error('timer ではない');
    await stores.schedules.claimRun('watch', held?.updatedAt ?? '', fired.at, 'schedule');
    await stores.schedules.completeRun('watch', fired.at, 'schedule');

    expect((await stores.schedules.get('watch'))?.lastScheduledRunAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 10, 0).toISOString(),
    );

    expect(scheduler.tick(at(2026, 8, 12, 9, 31))).toEqual([]);

    scheduler.stop();
  });

  it('未完了の手動発火を配り直しても、次の定期予定は動かない', async () => {
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
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 9, 0).toISOString(),
    );

    scheduler.stop();
  });

  it('長く止まっていた後の配り直しでも、次回は未来かつ元の位相の上にある', async () => {
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
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 12, 0).toISOString(),
    );
    expect(scheduler.tick(at(2026, 8, 12, 11, 31))).toEqual([]);
    expect(posted).toHaveLength(1);

    scheduler.stop();
  });

  it('2万周期を超えて止まっていても、次回は元の格子の上にある（走査で諦めない）', async () => {
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
    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      expected.toISOString(),
    );
    expect(new Date(expected).getSeconds()).toBe(0);

    scheduler.stop();
  });

  it('cron でも複数回ぶん止まっていた後の次回が、未来かつ元の系列の上にある', async () => {
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

    expect((await stores.schedules.get('watch'))?.lastScheduledRunAt).toBeUndefined();

    scheduler.stop();
  });

  it('手で起こしても定期の予定はずれない（再起動を挟んでも）', async () => {
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
    expect(scheduler.tick(clock)).toEqual(['watch']);
    const held = await stores.schedules.get('watch');
    await stores.schedules.claimRun(
      'watch',
      held?.updatedAt ?? '',
      clock.toISOString(),
      'schedule',
    );
    await stores.schedules.completeRun('watch', clock.toISOString(), 'schedule');

    clock = at(2026, 8, 12, 9, 10);
    expect(scheduler.run('watch')).toBe(true);
    const manual = posted.at(-1);
    expect(manual).toMatchObject({ type: 'timer', kind: 'watch', cause: 'manual' });
    const beforeManual = await stores.schedules.get('watch');
    await stores.schedules.claimRun(
      'watch',
      beforeManual?.updatedAt ?? '',
      at(2026, 8, 12, 9, 15).toISOString(),
      'manual',
    );
    await stores.schedules.completeRun('watch', at(2026, 8, 12, 9, 15).toISOString(), 'manual');

    expect(scheduler.list().find((item) => item.kind === 'watch')?.nextAt).toBe(
      at(2026, 8, 12, 10, 0).toISOString(),
    );
    scheduler.stop();

    const after = await stores.schedules.get('watch');
    expect(after?.lastRunAt).toBe(at(2026, 8, 12, 9, 15).toISOString());
    expect(after?.lastScheduledRunAt).toBe(at(2026, 8, 12, 9, 0).toISOString());

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

  it('周期を差し替えても、真の取りこぼしが無ければ即時発火しない（新しい格子の上で数え直す）', async () => {
    // 既定の仕込み（日報）を混ぜない: 日報の定刻をまたぐ時刻へ跳ぶので、無関係な発火が紛れ込むため
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    let clock = BASE;
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });

    await stores.schedules.put({
      ...plan('watch', { type: 'daily', at: '09:00' }),
      lastRunAt: at(2026, 8, 10, 9, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 10, 9, 0).toISOString(),
    });
    await scheduler.refresh();
    scheduler.start();

    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 60 }),
      lastRunAt: at(2026, 8, 10, 9, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 10, 9, 0).toISOString(),
    });
    await scheduler.refresh();

    const status = scheduler.list().find((item) => item.kind === 'watch');
    expect(status?.nextAt).toBe(at(2026, 8, 12, 9, 0).toISOString());
    expect(scheduler.tick(clock)).toEqual([]);

    clock = at(2026, 8, 12, 9, 0);
    expect(scheduler.tick(clock)).toEqual(['watch']);
    const fired = posted.at(-1);
    expect(fired).toMatchObject({ type: 'timer', kind: 'watch' });
    expect(fired && 'cause' in fired ? fired.cause : undefined).toBeUndefined();

    scheduler.stop();
  });

  it('取りこぼしの拾い直しの印は、配り直し（pendingRun）を挟むと次の発火まで持ち越さない', async () => {
    const stores = createMemoryStores();
    const posted: InboxEvent[] = [];
    let clock = at(2026, 8, 13, 10, 0);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => clock,
      schedules: stores.schedules,
    });

    await stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 1440 }),
      lastRunAt: at(2026, 8, 11, 22, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 11, 22, 0).toISOString(),
    });
    await scheduler.refresh();
    scheduler.start();

    const held = await stores.schedules.get('watch');
    await stores.schedules.claimRun(
      'watch',
      held?.updatedAt ?? '',
      at(2026, 8, 13, 10, 0).toISOString(),
      'schedule',
    );
    await scheduler.refresh();

    expect(scheduler.tick(clock)).toEqual(['watch']);
    expect(posted.at(-1)).toMatchObject({ cause: 'schedule' });

    await stores.schedules.completeRun('watch', at(2026, 8, 13, 10, 0).toISOString(), 'schedule');
    await scheduler.refresh();
    clock = at(2026, 8, 14, 10, 0);
    expect(scheduler.tick(clock)).toEqual(['watch']);
    const fired = posted.at(-1);
    expect(fired).toMatchObject({ type: 'timer', kind: 'watch' });
    expect(fired && 'cause' in fired ? fired.cause : undefined).toBeUndefined();

    scheduler.stop();
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
    const s = setup(at(2026, 8, 13, 10, 0));
    await s.stores.schedules.put({
      ...plan('watch', { type: 'every', minutes: 1440 }),
      lastRunAt: at(2026, 8, 11, 22, 0).toISOString(),
      lastScheduledRunAt: at(2026, 8, 11, 22, 0).toISOString(),
    });
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.tick(at(2026, 8, 13, 10, 0))).toEqual(['watch']);
    expect(s.posted.at(-1)).toMatchObject({
      type: 'timer',
      kind: 'watch',
      cause: 'schedule_catchup',
    });
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

    const first = s.scheduler.refresh();
    await s.stores.schedules.remove('watch');
    const second = s.scheduler.refresh();
    await Promise.all([first, second]);

    expect(s.scheduler.list().map((item) => item.kind)).toEqual([DAILY_REPORT_KIND]);
  });

  it('仕込まれた依頼には spec（周期そのもの）が乗り、既定の日報には乗らない', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('issue-round', { type: 'daily', at: '09:00' }));
    await s.scheduler.refresh();
    s.scheduler.start();

    const seeded = s.scheduler.list().find((item) => item.kind === 'issue-round');
    expect(seeded).toMatchObject({ spec: { type: 'daily', at: '09:00' } });

    const daily = s.scheduler.list().find((item) => item.kind === DAILY_REPORT_KIND);
    expect(daily).not.toHaveProperty('spec');

    s.scheduler.stop();
  });

  it('ストアが読めなくても時計は止まらず、既に仕込んである予定は消えない', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 30 }));
    await s.scheduler.refresh();
    s.scheduler.start();

    s.stores.schedules.list = () => Promise.reject(new Error('DB が揺れた'));
    await expect(s.scheduler.refresh()).rejects.toThrow('DB が揺れた');

    expect(s.scheduler.tick(at(2026, 8, 12, 8, 30))).toEqual(['watch']);

    s.scheduler.stop();
  });

  it('読めない行は unreadable() で持ち回り、読み直しで直っていれば消える（#2343）', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 30 }));
    await s.scheduler.refresh();
    expect(s.scheduler.unreadable()).toEqual([]);

    const real = s.stores.schedules.list.bind(s.stores.schedules);
    let broken = true;
    s.stores.schedules.list = async () => ({
      ...(await real()),
      unreadable: broken ? [{ kind: 'broken', reason: '不正な欄: spec' }] : [],
    });

    await s.scheduler.refresh();
    expect(s.scheduler.unreadable()).toEqual([{ kind: 'broken', reason: '不正な欄: spec' }]);
    expect(s.scheduler.list().map((item) => item.kind)).toContain('watch');

    broken = false;
    await s.scheduler.refresh();
    expect(s.scheduler.unreadable()).toEqual([]);
  });

  it('手で今すぐ起こせる（人間が待たずに確かめる経路も本番と同じ形）', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('issue-round', { type: 'daily', at: '09:00' }));
    await s.scheduler.refresh();
    s.scheduler.start();

    expect(s.scheduler.run('issue-round')).toBe(true);
    expect(s.posted).toMatchObject([{ type: 'timer', kind: 'issue-round' }]);
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
    clock = at(2026, 8, 12, 8, 2);

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

    await expect.poll(() => reading, { timeout: 3000 }).toBe(true);
    scheduler.stop();
    release();

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

    await expect(
      missingDailyReportDates({
        journal,
        at: cutoff,
        now: at(2026, 8, 12, 23, 0),
        lookbackDays: 3,
      }),
    ).resolves.toEqual(['2026-08-12']);
  });

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
      placeholder('2026-08-10', at(2026, 8, 10, 22, 0)),
      report('2026-08-11', at(2026, 8, 11, 22, 0)),
    ]);

    await expect(
      missingDailyReportDates({ journal, at: cutoff, now: at(2026, 8, 12, 9, 0), lookbackDays: 3 }),
    ).resolves.toEqual(['2026-08-10']);
  });

  describe('ページング（Issue #1283）— scanPageSize を変えても同じ結果になる', () => {
    const PAGE_SIZE = 3;

    function manyDecisionEntries(count: number): JournalEntry[] {
      const entries: JournalEntry[] = [];
      for (let i = 0; i < count; i += 1) {
        entries.push(entry('decision', new Date(at(2026, 8, 11, 10, 0).getTime() + i * 60_000)));
      }
      return entries;
    }

    it.each([0, 1, PAGE_SIZE, PAGE_SIZE + 1])(
      '日誌のエントリ数=%i: scanPageSize=3 と大きい scanPageSize で同じ結果になる',
      async (count) => {
        const journal = fakeJournal(manyDecisionEntries(count));

        const paged = await missingDailyReportDates({
          journal,
          at: cutoff,
          now: at(2026, 8, 12, 9, 0),
          lookbackDays: 3,
          scanPageSize: PAGE_SIZE,
        });
        const unpaged = await missingDailyReportDates({
          journal,
          at: cutoff,
          now: at(2026, 8, 12, 9, 0),
          lookbackDays: 3,
          scanPageSize: Math.max(count, 1) + 1000,
        });

        expect(paged).toEqual(unpaged);
        expect(paged).toEqual(count === 0 ? [] : ['2026-08-11']);
      },
    );

    it('壊れた行を捨てて短くなったページを終端と読まず、先の行まで読む（Issue #2494）', async () => {
      const first = entry('decision', at(2026, 8, 10, 15, 0));
      const broken = entry('decision', at(2026, 8, 10, 16, 0));
      const later = entry('decision', at(2026, 8, 11, 15, 0));
      const inner = fakeJournal([first, broken, later]);
      const journal = droppingAfterLimit(inner, (e) => e.id === broken.id);

      await expect(
        missingDailyReportDates({
          journal,
          at: cutoff,
          now: at(2026, 8, 12, 9, 0),
          lookbackDays: 3,
          scanPageSize: 2,
        }),
      ).resolves.toEqual(['2026-08-10', '2026-08-11']);
    });

    it('ページが丸ごと壊れていても、その先の古くない行まで読む（Issue #2605）', async () => {
      const first = entry('decision', at(2026, 8, 10, 15, 0));
      const brokenA = entry('decision', at(2026, 8, 10, 16, 0));
      const brokenB = entry('decision', at(2026, 8, 10, 17, 0));
      const later = entry('decision', at(2026, 8, 11, 15, 0));
      const inner = fakeJournal([first, brokenA, brokenB, later]);
      const journal = droppingAfterLimit(inner, (e) => e.id === brokenA.id || e.id === brokenB.id);

      await expect(
        missingDailyReportDates({
          journal,
          at: cutoff,
          now: at(2026, 8, 12, 9, 0),
          lookbackDays: 3,
          scanPageSize: 2,
        }),
      ).resolves.toEqual(['2026-08-10', '2026-08-11']);
    });

    it('scanPageSize を省略しても既定値（MISSING_DAILY_REPORT_SCAN_PAGE_SIZE）で動く', async () => {
      expect(MISSING_DAILY_REPORT_SCAN_PAGE_SIZE).toBeGreaterThan(0);
      const journal = fakeJournal([entry('decision', at(2026, 8, 11, 15, 0))]);

      await expect(
        missingDailyReportDates({
          journal,
          at: cutoff,
          now: at(2026, 8, 12, 9, 0),
          lookbackDays: 3,
        }),
      ).resolves.toEqual(['2026-08-11']);
    });
  });
});

// 子プロセスで測る: 投げ直しは未処理の拒否になり、同じプロセスでは vitest の unhandled error の歯に引っかかるため
describe('刻みの中で投げたとき（#438）', () => {
  it('跡を残してから投げ直す（握り潰さない）', async () => {
    const entry = siblingSrcPath(import.meta.url, 'schedule.ts');
    // 期限が来ている仕込みを渡す: 既定の仕込みだと最初の発火まで実時間で待ち、テストが時間切れになるため
    const failure = await runChildAgainstSrc([
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
    ]);

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(1);

    const stderr = failure?.stderr ?? '';
    expect(stderr).toContain('仕込みの刻みが例外で終わりました');
    expect(stderr).toContain('受信箱が投げた');
    expect(stderr).toMatch(/\n\s+at /u);
  });
});

describe('memoryTidyEntry — 記憶の棚卸しの刻み', () => {
  const at = { hour: 3, minute: 0 };

  it('⭐ 積む合図は distill（timer ではない）。reason は scheduled', () => {
    const event = memoryTidyEntry({ at }).event(new Date('2026-09-08T03:00:00Z'));

    expect(event.type).toBe('distill');
    if (event.type !== 'distill') throw new Error('distill ではない（上の assert が守る）');
    expect(event.reason).toBe('scheduled');
    expect(event.at).toBe('2026-09-08T03:00:00.000Z');
    expect(event.id.length).toBeGreaterThan(0);
  });

  it('名前は予約されている（schedule_create から乗っ取れない）', () => {
    expect(RESERVED_SCHEDULE_KINDS).toContain(MEMORY_TIDY_KIND);
    expect(memoryTidyEntry({ at }).kind).toBe(MEMORY_TIDY_KIND);
  });

  it('⭐ 取りこぼしは拾わない（同じ仕事を2回払わない）', () => {
    expect(memoryTidyEntry({ at }).catchUpMissed).toBe(false);
  });

  it('次の発火は指定時刻。過ぎていれば翌日の同じ時刻', () => {
    const entry = memoryTidyEntry({ at });
    const before = new Date(2026, 8, 8, 1, 0, 0);
    const after = new Date(2026, 8, 8, 5, 0, 0);

    expect(entry.nextAt(before)).toEqual(new Date(2026, 8, 8, 3, 0, 0));
    expect(entry.nextAt(after)).toEqual(new Date(2026, 8, 9, 3, 0, 0));
  });

  it('説明に時刻が入る（人間が schedule_list で読む唯一の手掛かり）', () => {
    expect(memoryTidyEntry({ at: { hour: 5, minute: 7 } }).description).toContain('05:07');
  });
});

describe('describeUnreadableSchedules — クローンと digest が使う1文（#2343）', () => {
  it('0件は null（何も出さない）', () => {
    expect(describeUnreadableSchedules([])).toBeNull();
  });

  it('件数と kind、消された依頼ではないこと、kind が取れない行の数を言う', () => {
    const note = describeUnreadableSchedules([{ kind: 'a', reason: 'r' }, { reason: 'r' }]);
    expect(note).toContain('読めない継続中の依頼が 2 件ある');
    expect(note).toContain('kind: a');
    expect(note).toContain('kind が取れない行が 1 件');
    expect(note).toContain('消された依頼ではない');
  });

  it('kind が全部取れないときはそう言う。kind は上限で切って、切ったと言う', () => {
    expect(describeUnreadableSchedules([{ reason: 'r' }])).toContain('kind も取れない');
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: `x${i}`, reason: 'r' }));
    const note = describeUnreadableSchedules(many);
    expect(note).toContain('読めない継続中の依頼が 12 件ある');
    expect(note).toContain('ほか 2 件');
    expect(note).not.toContain('x11');
  });
});
