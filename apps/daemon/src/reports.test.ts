import type { DailyReport, JournalEntry, JournalQuery, JournalStore } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  compareDailyReportsNewestFirst,
  listDailyReports,
  REPORT_WINDOW_SLACK,
} from './reports.js';

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

// `at` で並べ直さない: 本物は追記順で並べるので、`at` 順にすると「書いた順と日付順が食い違う」形を作れなくなるため。
function fakeJournal(appended: readonly JournalEntry[]) {
  const windows: (number | undefined)[] = [];
  const journal: JournalStore = {
    async append() {
      throw new Error('このテストでは追記しない');
    },
    async list(query: JournalQuery = {}) {
      return (await journal.listPage(query)).entries;
    },
    async listPage(query: JournalQuery = {}) {
      windows.push(query.limit);
      let found = [...appended].reverse();
      if (query.types) found = found.filter((entry) => query.types?.includes(entry.type));
      const { limit } = query;
      if (limit === undefined) return { entries: found, next: null };
      const entries = found.slice(0, limit);
      const last = entries[entries.length - 1];
      return {
        entries,
        next: found.length > limit && last !== undefined ? { id: last.id, at: last.at } : null,
      };
    },
    async get() {
      return null;
    },
    async oldestAt() {
      throw new Error('このテストでは使わない');
    },
    async clear() {
      throw new Error('このテストでは消さない');
    },
  };
  return { journal, windows };
}

describe('日報の並び', () => {
  it('後から書かれた古い日付の日報を、新しい日付の上に出さない', async () => {
    const { journal } = fakeJournal([
      report('2026-08-20', '2026-08-20T22:00:00.000Z'),
      report('2026-08-21', '2026-08-21T22:00:00.000Z'),
      report('2026-08-19', '2026-08-22T00:30:00.000Z'),
    ]);

    const reports = await listDailyReports(journal, 7);

    expect(reports.map((entry) => entry.date)).toEqual(['2026-08-21', '2026-08-20', '2026-08-19']);
  });

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
      report('2026-08-20', '2026-08-20T22:00:00.000Z'),
      report('2026-08-20', '2026-08-21T00:30:00.000Z'),
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

  it('最初の窓に収まらない位置にある新しい日付を、読み足して拾う', async () => {
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

    expect(windows.length).toBeGreaterThan(1);
    expect(reports[0]?.date).toBe('2026-09-30');
  });

  it('日誌を読み切ったら、足りていなくても読み足しを止める', async () => {
    const { journal, windows } = fakeJournal([report('2026-08-19', '2026-08-19T22:00:00.000Z')]);

    await listDailyReports(journal, 7);

    expect(windows).toEqual([7 + REPORT_WINDOW_SLACK]);
  });

  it('窓が丸ごと読めない行で埋まっていても、先の日報まで読む（Issue #2604 / #2605）', async () => {
    const good = report('2026-08-19', '2026-08-19T22:00:00.000Z');
    const broken = Array.from({ length: 1 + REPORT_WINDOW_SLACK }, (_, i) =>
      report('2026-08-20', `2026-08-20T22:${String(i).padStart(2, '0')}:00.000Z`),
    );
    const brokenIds = new Set(broken.map((entry) => entry.id));
    const { journal: inner } = fakeJournal([good, ...broken]);
    const journal: JournalStore = {
      ...inner,
      listPage: async (query) => {
        const page = await inner.listPage(query);
        return { entries: page.entries.filter((e) => !brokenIds.has(e.id)), next: page.next };
      },
    };

    const reports = await listDailyReports(journal, 1);

    expect(reports.map((entry) => entry.id)).toEqual([good.id]);
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
