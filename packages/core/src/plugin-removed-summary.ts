import type { RemovedItem } from './plugin-extract.js';

export const REMOVED_JOURNAL_MAX_PATHS = 20;
export const REMOVED_JOURNAL_MAX_PATH_LENGTH = 120;

// `_` などへ置き換えない: 置き換えた文字が別の path に見えるから。
function cleanForJournal(raw: string): string {
  // eslint-disable-next-line no-control-regex -- 制御文字を落とすための検査
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  const points = [...cleaned];
  if (points.length <= REMOVED_JOURNAL_MAX_PATH_LENGTH) return cleaned;
  return `${points.slice(0, REMOVED_JOURNAL_MAX_PATH_LENGTH).join('')}…`;
}

export function summarizeRemovedForJournal(removed: readonly RemovedItem[]): string | null {
  if (removed.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of removed) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  const byReason = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, count]) => `${reason} ${count}件`)
    .join(', ');
  const lines = removed
    .map((item) => `${cleanForJournal(item.plugin)}:${cleanForJournal(item.path)}`)
    .sort();
  const shown = lines.slice(0, REMOVED_JOURNAL_MAX_PATHS);
  const rest = lines.length - shown.length;
  return `${byReason}（${shown.join(', ')}${rest > 0 ? `, ほか ${rest} 件` : ''}）`;
}
