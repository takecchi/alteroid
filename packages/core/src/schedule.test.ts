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
  selfInitiativeEntry,
} from './schedule.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import type { JournalQuery, JournalStore } from './store.js';

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
