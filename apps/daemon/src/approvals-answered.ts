import { localDate } from '@alteroid/core';
import type { PendingApproval } from '@alteroid/core';

/**
 * 「回答済み」の画面（`GET /approvals?answeredOn=` と `GET /approvals/answered-dates`）が使う
 * 純関数。HTTP も保存先も知らない（fs / pg のどちらの `listApprovals` の結果にも同じように
 * 当たる——メモリ上の filter と sort だけ）。
 *
 * **決着の日時は `answeredAt`、無ければ `withdrawnAt`。** 取り下げ済み（`approval_withdraw`）も
 * 「決着した」件であって、これを外すと、従来の「回答済み・取り下げ済みも見る」で見えていた
 * 取り下げ済みが Web から見えなくなる（能力の削除）。`approvalUpdatedAt`（`withdrawnAt` を先に
 * 見る）とは優先が逆である——あちらは「最後に変わった時刻」、こちらは「人間が答えた日を軸に
 * 並べる」ので、両方在る行（正常な経路では無い）は回答の日に置く。
 *
 * **日付は `localDate()`（日報の対象日と同じ関数・同じデーモンの TZ）で決める。** 自前の TZ 計算は
 * 持たない。ブラウザの TZ で日を決めると、日報と日付の区切りが食い違う。
 */
export function approvalSettledAt(
  approval: Pick<PendingApproval, 'answeredAt' | 'withdrawnAt'>,
): string | undefined {
  return approval.answeredAt ?? approval.withdrawnAt ?? undefined;
}

/** 決着した日（`YYYY-MM-DD`。デーモンの `localDate`）。決着していなければ undefined。 */
export function approvalSettledDate(
  approval: Pick<PendingApproval, 'answeredAt' | 'withdrawnAt'>,
): string | undefined {
  const settledAt = approvalSettledAt(approval);
  if (settledAt === undefined) return undefined;
  const at = new Date(settledAt);
  // スキーマが日時の形を保証している。読めない値は日付を作らず、どの日にも載せない
  // （`Invalid Date` から `NaN-NaN-NaN` の日付を作らない）。
  return Number.isNaN(at.getTime()) ? undefined : localDate(at);
}

/**
 * 決着の日時の新しい順。**同時刻なら id の降順**（全体の向きを逆にしたもの。並びが
 * ストアの生の並びに乗らない）。
 */
export function compareSettledNewestFirst(
  a: Pick<PendingApproval, 'id' | 'answeredAt' | 'withdrawnAt'>,
  b: Pick<PendingApproval, 'id' | 'answeredAt' | 'withdrawnAt'>,
): number {
  const atA = Date.parse(approvalSettledAt(a) ?? '');
  const atB = Date.parse(approvalSettledAt(b) ?? '');
  if (atA !== atB) return atB - atA;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** `date` に決着した承認だけを、決着の新しい順に。 */
export function approvalsSettledOn<
  T extends Pick<PendingApproval, 'id' | 'answeredAt' | 'withdrawnAt'>,
>(approvals: readonly T[], date: string): T[] {
  return approvals
    .filter((approval) => approvalSettledDate(approval) === date)
    .sort(compareSettledNewestFirst);
}

export interface AnsweredDate {
  date: string;
  count: number;
}

/**
 * 決着のあった日と件数を、新しい日が上の順に。`beforeDate` を渡すと、その日**より古い**日だけ
 * （前の頁の最後の日を渡して続きを取る。`GET /reports` の `beforeDate` と同じ向き）。
 * `YYYY-MM-DD` は辞書順が日付順になる。
 */
export function answeredDates(
  approvals: readonly Pick<PendingApproval, 'answeredAt' | 'withdrawnAt'>[],
  options: { limit: number; beforeDate?: string },
): AnsweredDate[] {
  const counts = new Map<string, number>();
  for (const approval of approvals) {
    const date = approvalSettledDate(approval);
    if (date === undefined) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .filter((entry) => options.beforeDate === undefined || entry.date < options.beforeDate)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, options.limit);
}
