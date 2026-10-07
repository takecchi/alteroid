import { isDailyReport } from '@alteroid/core';
import type { DailyReport, JournalStore } from '@alteroid/core';

// 並びはデーモンが決め、画面で並べ直さない: 画面で並べると CLI（先頭の1件を「最新の日報」として出す）とクローンとで「最新」が食い違うため。
export function compareDailyReportsNewestFirst(a: DailyReport, b: DailyReport): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return 0;
}

export const REPORT_WINDOW_SLACK = 32;

// `limit` 件だけ読んで並べ直さない: 日誌は書いた順に切るので、窓の外に窓の中より新しい日付の日報が残りうるため。
export async function listDailyReports(
  journal: JournalStore,
  limit: number,
): Promise<DailyReport[]> {
  let window = limit + REPORT_WINDOW_SLACK;

  for (;;) {
    const { entries, next } = await journal.listPage({ types: ['daily_report'], limit: window });
    const reports = entries.filter(isDailyReport).sort(compareDailyReportsNewestFirst);
    const picked = reports.slice(0, limit);

    // 件数が窓に満たないことを終端の印にしない: 読めない行は `limit` の後で捨てられるため。
    if (next === null) return picked;

    // 窓は読み切っていないのに limit 未満なら isSettled の前に窓を倍にする: `picked` が空でも真になり、読めない行の向こうの日報を取りこぼすため。
    if (picked.length < limit) {
      window *= 2;
      continue;
    }

    if (isSettled(picked, entries)) return picked;

    window *= 2;
  }
}

function isSettled(picked: readonly DailyReport[], window: readonly { at: string }[]): boolean {
  const last = picked[picked.length - 1];
  if (last === undefined) return true;

  let oldest = window[0]?.at;
  if (oldest === undefined) return true;
  for (const entry of window) if (entry.at < oldest) oldest = entry.at;

  return last.date >= dayAfter(oldest);
}

function dayAfter(at: string): string {
  const parsed = Date.parse(at);
  // 読めない `at` は読み足す側へ倒す: 空文字だと `last.date >= ''` が常に真になり、足りていないのに足りたと判定するため。
  if (Number.isNaN(parsed)) return '9999-12-31';
  return new Date(parsed + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// `id` を第3のキーに足さない: `compareDailyReportsNewestFirst` は `GET /reports/:date` の並びも決めており、変えるとそちらの並びも変わるため。
function isOlderThanBoundary(
  report: Pick<DailyReport, 'date' | 'at'>,
  before: { date: string; at: string },
): boolean {
  if (report.date !== before.date) return report.date < before.date;
  return report.at < before.at;
}

export async function listDailyReportsBefore(
  journal: JournalStore,
  limit: number,
  before: { date: string; at: string },
): Promise<DailyReport[]> {
  let window = limit + REPORT_WINDOW_SLACK;

  for (;;) {
    const { entries, next } = await journal.listPage({ types: ['daily_report'], limit: window });
    const reports = entries.filter(isDailyReport).sort(compareDailyReportsNewestFirst);
    const picked = reports.filter((report) => isOlderThanBoundary(report, before)).slice(0, limit);

    // 件数が窓に満たないことを終端の印にしない: 読めない行は `limit` の後で捨てられるため。
    if (next === null) return picked;

    // 窓は読み切っていないのに limit 未満なら isSettled の前に窓を倍にする: 境界の外側にまだ行があるのに、`picked` が少ないことだけで「もう無い」と判定してしまうため。
    if (picked.length < limit) {
      window *= 2;
      continue;
    }

    if (isSettled(picked, entries)) return picked;

    window *= 2;
  }
}
