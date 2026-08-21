import type { DailyReport, JournalEntry, JournalQuery, JournalStore } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  compareDailyReportsNewestFirst,
  listDailyReports,
  REPORT_WINDOW_SLACK,
} from './reports.js';

/**
 * 日報の行。**`date`（何日ぶんか）と `at`（いつ書かれたか）を別に与える** —
 * この2つが食い違うことが、このファイルで測っている問題そのものである。
 */
function report(date: string, at: string, unavailable?: string): DailyReport {
  return {
    type: 'daily_report',
    id: `${date}@${at}`,
    at,
    date,
    body: `${date} の日報`,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

/**
 * 日誌の代わり。**本物と同じ「書いた順の逆」で返し、`limit` で切る**
 * （`storage-pg` は `seq` の降順、`storage-fs` は新しいファイルから行を後ろから）。
 *
 * **`at` で並べ直さないこと。** 本物は `at` ではなく追記順で並べるので、ここで
 * `at` 順にすると「書いた順と日付順が食い違う」形をそのまま作れなくなる。
 *
 * 読んだ窓の大きさを `windows` に全部残す — 読み足しが起きたかどうかは結果だけ
 * からは分からない（1回で足りた場合と同じ答えになる）。
 */
function fakeJournal(appended: readonly JournalEntry[]) {
  const windows: (number | undefined)[] = [];
  const journal: JournalStore = {
    async append() {
      throw new Error('このテストでは追記しない');
    },
    async list(query: JournalQuery = {}) {
      windows.push(query.limit);
      let found = [...appended].reverse();
      if (query.types) found = found.filter((entry) => query.types?.includes(entry.type));
      return query.limit === undefined ? found : found.slice(0, query.limit);
    },
    async get() {
      return null;
    },
  };
  return { journal, windows };
}

describe('日報の並び', () => {
  /**
   * ⭐ この1本が人間の申告そのものである。「WebUI の日報の並び順が変。ちゃんと
   * 上が新しくて下が古くなるべきでは」。
   *
   * 起動時の遡り生成（`missingDailyReportDates` → `#dailyReport`）では前の日ぶんの
   * 日報が今日書かれるので、**書いた順で返すと古い日付が先頭に来る。**
   */
  it('後から書かれた古い日付の日報を、新しい日付の上に出さない', async () => {
    const { journal } = fakeJournal([
      report('2026-08-20', '2026-08-20T22:00:00.000Z'),
      report('2026-08-21', '2026-08-21T22:00:00.000Z'),
      // 再起動の後追いで、08-19 の日報が 08-22 に書かれた（＝最後に書かれた行）
      report('2026-08-19', '2026-08-22T00:30:00.000Z'),
    ]);

    const reports = await listDailyReports(journal, 7);

    expect(reports.map((entry) => entry.date)).toEqual(['2026-08-21', '2026-08-20', '2026-08-19']);
  });

  /**
   * `limit=1` は「最新の日報」を出す口である（ダッシュボードの1枚と CLI の
   * `/report`）。**ここが書いた順のままだと、遡り生成の直後に古い日の日報が
   * 「最新」として出る。**
   */
  it('limit=1 は日付がいちばん新しい日報を返す（最後に書かれた行ではない）', async () => {
    const { journal } = fakeJournal([
      report('2026-08-21', '2026-08-21T22:00:00.000Z'),
      report('2026-08-19', '2026-08-22T00:30:00.000Z'),
    ]);

    const reports = await listDailyReports(journal, 1);

    expect(reports.map((entry) => entry.date)).toEqual(['2026-08-21']);
  });

  it('同じ日に複数あるときは、書いた時刻の新しい方を先に出す', async () => {
    const { journal } = fakeJournal([
      report('2026-08-20', '2026-08-20T22:00:00.000Z'), // その日の締め
      report('2026-08-20', '2026-08-21T00:30:00.000Z'), // 起動時の遡り生成
    ]);

    const reports = await listDailyReports(journal, 7);

    expect(reports.map((entry) => entry.at)).toEqual([
      '2026-08-21T00:30:00.000Z',
      '2026-08-20T22:00:00.000Z',
    ]);
  });

  it('日報以外の行は数えない（日誌には他の種別が大量に混ざる）', async () => {
    const { journal } = fakeJournal([
      report('2026-08-19', '2026-08-19T22:00:00.000Z'),
      {
        type: 'exchange',
        id: 'x1',
        at: '2026-08-20T00:00:00.000Z',
        with: 'human',
        role: 'inbound',
        text: 'やあ',
      },
    ]);

    const reports = await listDailyReports(journal, 7);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.date).toBe('2026-08-19');
  });

  it('1件も無ければ空を返す', async () => {
    const { journal } = fakeJournal([]);
    await expect(listDailyReports(journal, 7)).resolves.toEqual([]);
  });

  /**
   * **窓の外に、窓の中より新しい日付が残りうる。** 日誌は書いた順に切るので、
   * `limit` 件だけ読んで並べ直す実装はこの形で静かに間違う — 並べ直しているので
   * 「並んでいる」ようには見えるが、出すべき行が窓に入っていない。
   *
   * 窓の初期値は `limit + REPORT_WINDOW_SLACK` なので、そこに収まらない件数を
   * 定数から組み立てる（定数を変えてもこのテストの意味が壊れないように）。
   */
  it('最初の窓に収まらない位置にある新しい日付を、読み足して拾う', async () => {
    // 後に書かれた行ほど窓に入る。だから**いちばん新しい日付をいちばん先に書き**、
    // その後ろに古い日付の書き直しを窓が溢れるまで積む（＝後追いが続いた状態）。
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    const appended: JournalEntry[] = [
      report('2026-09-30', '2026-09-30T22:00:00.000Z'), // 最も新しい日付・最も古い書き込み
    ];
    for (let i = 0; i < REPORT_WINDOW_SLACK + 5; i += 1) {
      const day = String(10 + (i % 20)).padStart(2, '0');
      appended.push(report(`2026-08-${day}`, new Date(base + i * 60_000).toISOString()));
    }

    const { journal, windows } = fakeJournal(appended);

    const reports = await listDailyReports(journal, 3);

    // 読み足しが起きたこと自体を見る（1回で足りたなら窓は1つしか無い）。
    expect(windows.length).toBeGreaterThan(1);
    expect(reports[0]?.date).toBe('2026-09-30');
  });

  /**
   * 読み足しは**終わらなければならない**。日誌を読み切った（要求より少なく
   * 返った）ら、それ以上は存在しないのでそこで止める。
   */
  it('日誌を読み切ったら、足りていなくても読み足しを止める', async () => {
    const { journal, windows } = fakeJournal([report('2026-08-19', '2026-08-19T22:00:00.000Z')]);

    await listDailyReports(journal, 7);

    expect(windows).toEqual([7 + REPORT_WINDOW_SLACK]);
  });

  it('「作れなかった」印の行も一覧に出す（隠すと、来ていない日と区別できない）', async () => {
    const { journal } = fakeJournal([
      report('2026-08-19', '2026-08-19T22:00:00.000Z', '枠に当たった'),
    ]);

    const reports = await listDailyReports(journal, 7);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.unavailable).toBe('枠に当たった');
  });

  it('比較そのもの: 日付が先、同じ日なら書いた時刻', () => {
    const older = report('2026-08-19', '2026-08-22T00:30:00.000Z');
    const newer = report('2026-08-21', '2026-08-21T22:00:00.000Z');
    expect(compareDailyReportsNewestFirst(newer, older)).toBeLessThan(0);
    expect(compareDailyReportsNewestFirst(older, newer)).toBeGreaterThan(0);

    const close = report('2026-08-20', '2026-08-20T22:00:00.000Z');
    const catchup = report('2026-08-20', '2026-08-21T00:30:00.000Z');
    expect(compareDailyReportsNewestFirst(catchup, close)).toBeLessThan(0);
    expect(compareDailyReportsNewestFirst(close, close)).toBe(0);
  });
});
