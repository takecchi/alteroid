import { usageDate } from '@alteroid/core/usage';

/** ブラウザの暦で `days` 日ずらした日を、台帳の日付の形（`usageDate`）で返す。ホームのタイルと利用状況の画面が同じものを使う */
export function shiftedUsageDate(base: Date, days: number): string {
  return usageDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + days));
}
