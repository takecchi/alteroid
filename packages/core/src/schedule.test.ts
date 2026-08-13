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
import type { InboxEvent, JournalEntry, ScheduledRequest } from './schema.js';
import type { JournalQuery, JournalStore } from './store.js';
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

describe('継続中の依頼（時間起点の仕込み）', () => {
  const plan = (
    kind: string,
    spec: ScheduledRequest['spec'],
    request = 'GitHub の issue を見て実装を進める',
  ): ScheduledRequest => ({
    kind,
    spec,
    request,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
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

  it('周期が同じなら読み直しても予定はずれない（前回時刻だけ新しくなる）', async () => {
    const s = setup(at(2026, 8, 12, 8, 0));
    await s.stores.schedules.put(plan('watch', { type: 'every', minutes: 30 }));
    await s.scheduler.refresh();
    s.scheduler.start();

    const before = s.scheduler.list().find((item) => item.kind === 'watch')?.nextAt;
    s.set(at(2026, 8, 12, 8, 20));
    await s.stores.schedules.markRun('watch', '2026-08-12T08:20:00.000Z');
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
});
