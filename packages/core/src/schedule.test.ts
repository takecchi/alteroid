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
    await s.stores.schedules.claimRun('watch', held?.updatedAt ?? '', '2026-08-12T08:20:00.000Z');
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
});
