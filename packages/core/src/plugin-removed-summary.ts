import type { RemovedItem } from './plugin-extract.js';

/** 日誌に載せる path の数の上限。超えた分は件数だけにする。 */
export const REMOVED_JOURNAL_MAX_PATHS = 20;
/** 日誌に載せる path 1 本の長さの上限（UTF-16 コード単位）。 */
export const REMOVED_JOURNAL_MAX_PATH_LENGTH = 120;

/**
 * 外部由来の文字列を日誌に載せられる形にする。制御文字・書式制御文字（双方向制御・ゼロ幅）・
 * 行区切りを落とし、長さを切る。落とさずに `_` などへ置き換えないのは、置き換えた文字が
 * 別の path に見えるのを避けるため。
 */
function cleanForJournal(raw: string): string {
  // eslint-disable-next-line no-control-regex -- 制御文字を落とすための検査
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  // コードポイントの途中で切らない。
  const points = [...cleaned];
  if (points.length <= REMOVED_JOURNAL_MAX_PATH_LENGTH) return cleaned;
  return `${points.slice(0, REMOVED_JOURNAL_MAX_PATH_LENGTH).join('')}…`;
}

/**
 * 展開しなかったものを、日誌の1行へ畳む。理由ごとの件数と、先頭 {@link REMOVED_JOURNAL_MAX_PATHS} 件の
 * `<plugin>:<path>`。超えた分は「ほか N 件」。空なら `null`。
 */
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
