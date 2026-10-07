import { localDate } from '@alteroid/core';
import type { PendingApproval } from '@alteroid/core';

// 取り下げ済みも決着として数える: 外すと、従来見えていた取り下げ済みが Web から見えなくなるため。
export function approvalSettledAt(
  approval: Pick<PendingApproval, 'answeredAt' | 'withdrawnAt'>,
): string | undefined {
  return approval.answeredAt ?? approval.withdrawnAt ?? undefined;
}

// 日付はブラウザの TZ で決めず `localDate()` で決める: 日報と日付の区切りが食い違うため。
export function approvalSettledDate(
  approval: Pick<PendingApproval, 'answeredAt' | 'withdrawnAt'>,
): string | undefined {
  const settledAt = approvalSettledAt(approval);
  if (settledAt === undefined) return undefined;
  const at = new Date(settledAt);
  // 読めない値は日付を作らない: `Invalid Date` から `NaN-NaN-NaN` の日付ができるため。
  return Number.isNaN(at.getTime()) ? undefined : localDate(at);
}

// 同時刻は id の降順にする: 並びをストアの生の並びに乗せないため。
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
