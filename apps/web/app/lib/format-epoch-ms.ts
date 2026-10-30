import { formatDateTime, formatRelative } from '@alteroid/logic';

/** epoch ms を ISO 文字列へ戻して、画面の日時の書き方にする（logic の format が受けるのは ISO 文字列のため） */
export function formatEpochMs(ms: number): string {
  return formatDateTime(new Date(ms).toISOString());
}

export function formatEpochMsRelative(ms: number): string {
  return formatRelative(new Date(ms).toISOString());
}
