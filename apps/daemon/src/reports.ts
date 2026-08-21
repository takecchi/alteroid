import { isDailyReport } from '@alteroid/core';
import type { DailyReport, JournalStore } from '@alteroid/core';

/**
 * 日報の並び — **「何日ぶんの日報か」（`date`）の新しい順**。
 *
 * 日誌の並びは「書いた順の逆」であって（`storage-pg` は `seq` の降順、
 * `storage-fs` は新しいファイルから行を後ろから）、**日報の日付順とは一致しない。**
 * 一致しなくなる経路は起動時の遡り生成（`schedule.ts` の
 * `missingDailyReportDates` → `clone.ts` の `#dailyReport`）で、**前の日ぶんの
 * 日報が今日書かれる。** 1回の後追いの中は古い日から順に書かれるので中では
 * 揃うが、**その後追いより前に書かれた新しい日の日報は、全部それより下に沈む。**
 *
 * 実際に人間から出た申告は「WebUI の日報の並び順が変。ちゃんと上が新しくて下が
 * 古くなるべきでは」である。たとえば 08-21 の日報を書いた後に再起動して 08-19 の
 * 後追いが走ると、一覧の先頭は 08-19 になる（`unavailable` の印が付いた日は
 * 「まだ書けていない」と数えるので、**再起動のたびに後追いの対象になり続ける** —
 * つまりこれは稀な事故ではなく、日常的に起きる形である）。
 *
 * **並びはデーモンが決める（画面で並べ直さない）。** 並べ直す場所を画面にすると、
 * CLI（`/report` は先頭の1件を「最新の日報」として出す）とクローンとで「最新」が
 * 食い違う。だから直しはここ1か所である。
 */
export function compareDailyReportsNewestFirst(a: DailyReport, b: DailyReport): number {
  // 日は「その日報が何日について書かれたか」。`YYYY-MM-DD` は辞書順＝時系列順。
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  // 同じ日に複数あるとき（締めと遡り生成）は、書いた時刻の新しい方を先に出す。
  // 画面が「その日の最後に書かれたもの」を既定で開く前提がこれである。
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return 0;
}

/**
 * 窓を最初からどれだけ広く取るか（要求された件数への上乗せ）。
 *
 * 日報は1日に多くて数件なので、既定の後追い（`ALTEROID_REPORT_LOOKBACK_DAYS`、
 * 既定3日）で日付順と書いた順が食い違う範囲はこれで十分に覆える。**足りなくても
 * 結果は狂わない** — 下の `listDailyReports` が足りたかどうかを判定して読み足す。
 * ここは「1回の読みで済む確率」を上げるためだけの数である。
 */
export const REPORT_WINDOW_SLACK = 32;

/**
 * 日報を日付の新しい順に `limit` 件返す。
 *
 * **`limit` 件だけ読んで並べ直すのでは足りない。** 日誌は書いた順に切るので、
 * 窓の外（＝もっと前に書かれた行）に、窓の中より新しい日付の日報が残りうる。
 * 遡り生成が走った直後の窓はまさにその形になっている。
 *
 * だから窓を広めに取り、**足りたことを確かめてから**切る。確かめ方は日報の性質
 * 1つだけに乗っている — **日報はその日が来る前には書かれない**（締めの発火は
 * その日の中、後追いは過ぎた日について走る）ので `date <= at の日付` である。
 * つまり窓の外の行の日付は、窓の中で最も古い `at` の日付＋1日を超えない
 * （＋1日は時間帯の差ぶんの余裕。デーモンの時間帯を知らなくても成り立つ形にする）。
 * 返す最後の行の日付がその境界以上なら、**窓の外の行はどれもそれより下にしか
 * 並べられない** ＝ 読み足す必要が無い。
 *
 * 足りなければ窓を倍にして読み直す。日誌を読み切った（要求より少なく返った）
 * ときは、それ以上は存在しないのでそこで終わる。
 */
export async function listDailyReports(
  journal: JournalStore,
  limit: number,
): Promise<DailyReport[]> {
  let window = limit + REPORT_WINDOW_SLACK;

  for (;;) {
    const entries = await journal.list({ types: ['daily_report'], limit: window });
    const reports = entries.filter(isDailyReport).sort(compareDailyReportsNewestFirst);
    const picked = reports.slice(0, limit);

    // 窓より少なく返ったなら日誌を読み切っている（これ以上は存在しない）。
    if (entries.length < window) return picked;
    if (isSettled(picked, entries)) return picked;

    window *= 2;
  }
}

/**
 * 窓の外の行がこの結果を動かせないか。
 *
 * 窓の外の行は、窓の中のどれよりも前に書かれている（＝ `at` が古い）。日報は
 * その日が来る前には書かれないので、それらの日付は「窓の中で最も古い `at` の
 * 日付＋1日」を超えない。境界と同じ日付の行が外にあっても、`at` が古いので
 * 同じ日の中では下に来る。よって**最後の行の日付が境界以上なら動かせない。**
 */
function isSettled(picked: readonly DailyReport[], window: readonly { at: string }[]): boolean {
  const last = picked[picked.length - 1];
  if (last === undefined) return true;

  let oldest = window[0]?.at;
  if (oldest === undefined) return true;
  for (const entry of window) if (entry.at < oldest) oldest = entry.at;

  return last.date >= dayAfter(oldest);
}

/** ISO の時刻の「UTC 日付＋1日」を `YYYY-MM-DD` で返す。 */
function dayAfter(at: string): string {
  const parsed = Date.parse(at);
  // 読めない `at` は境界を作れない。**緩い側（＝読み足す側）へ倒す** —
  // 空文字は「どの日付よりも小さい」ので `last.date >= ''` が常に真になり、
  // 足りていないのに足りたと判定してしまう。
  if (Number.isNaN(parsed)) return '9999-12-31';
  return new Date(parsed + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
