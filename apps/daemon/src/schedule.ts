import {
  dailyReportEntry,
  memoryTidyEntry,
  parseTimeOfDay,
  placedEnvValue,
  SCHEDULE_EVERY_MINUTES_MAX,
  selfInitiativeEntry,
  type ScheduleEntry,
  type TimeOfDay,
} from '@alteroid/core';

import { OFF_SPELLINGS } from './env-every-minutes.js';

export interface ScheduleConfig {
  dailyReportAt: TimeOfDay | null;
  initiativeEveryMinutes: number | null;
  // 日報と別の時刻にする: 同じ時刻だと片方が受信箱で待ち、日報の中身が棚卸しの報告で薄まるため。
  memoryTidyAt: TimeOfDay | null;
  reportLookbackDays: number;
  notes: string[];
}

export const DEFAULT_DAILY_REPORT_AT = '22:00';
// 人間が話しかけてくる時間帯を避ける: 棚卸しは記憶を書き換えるターンで、走っている間は受信箱の他の仕事が待つため。
export const DEFAULT_MEMORY_TIDY_AT = '03:00';
/**
 * 発意 tick の既定間隔（分）。
 *
 * 60 にしない: tick の瞬間がプロンプトキャッシュの失効と重なると、そのターンは文脈を全部書き直す最も高い1回になるため。
 * `compose.yaml` の `${ALTEROID_INITIATIVE_EVERY:-55}` とこの値は揃える: 別の値で固定すると、compose 経由の起動ではこの定数が一度も使われないため。
 */
export const DEFAULT_INITIATIVE_EVERY_MINUTES = 55;
// 下限は 1 分: 起動側（`selfInitiativeEntry`）が 1 分へ切り上げるので、読み取りで通すと入れた値と違う周期で黙って動くため。切り上げて採るのではなく既定へ倒す。
export const MIN_INITIATIVE_EVERY_MINUTES = 1;
export const DEFAULT_REPORT_LOOKBACK_DAYS = 3;
// 後追いで遡る日数の上限（#4723）: 上限が無いと、遡る起点の日付が Invalid Date になり後追いが壊れるため。1年より前の日報を後から書かせる理由は無い
export const MAX_REPORT_LOOKBACK_DAYS = 365;

// 「HH:MM または off」の環境変数。未設定なら既定、off なら null、読めなければ注意を足して既定
function readTimeOfDayEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultAt: string,
  notes: string[],
): TimeOfDay | null {
  const raw = placedEnvValue(env, name);
  if (raw === null) return parseTimeOfDay(defaultAt);
  if (OFF_SPELLINGS.has(raw.toLowerCase())) return null;
  const parsed = parseTimeOfDay(raw);
  if (parsed === null) {
    notes.push(`${name}="${raw}" は HH:MM として読めないので既定 ${defaultAt} を使う`);
    return parseTimeOfDay(defaultAt);
  }
  return parsed;
}

export function readScheduleConfig(env: NodeJS.ProcessEnv = process.env): ScheduleConfig {
  const notes: string[] = [];

  const dailyReportAt = readTimeOfDayEnv(
    env,
    'ALTEROID_DAILY_REPORT_AT',
    DEFAULT_DAILY_REPORT_AT,
    notes,
  );
  const memoryTidyAt = readTimeOfDayEnv(
    env,
    'ALTEROID_MEMORY_TIDY_AT',
    DEFAULT_MEMORY_TIDY_AT,
    notes,
  );

  const rawEvery = placedEnvValue(env, 'ALTEROID_INITIATIVE_EVERY');
  let initiativeEveryMinutes: number | null = DEFAULT_INITIATIVE_EVERY_MINUTES;
  if (rawEvery !== null) {
    if (OFF_SPELLINGS.has(rawEvery.toLowerCase())) {
      initiativeEveryMinutes = null;
    } else {
      const parsed = Number(rawEvery);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        notes.push(
          `ALTEROID_INITIATIVE_EVERY="${rawEvery}" は分数として読めないので既定 ${DEFAULT_INITIATIVE_EVERY_MINUTES} を使う`,
        );
      } else if (parsed < MIN_INITIATIVE_EVERY_MINUTES) {
        notes.push(
          `ALTEROID_INITIATIVE_EVERY="${rawEvery}" は下限 ${MIN_INITIATIVE_EVERY_MINUTES} 分を下回っているので既定 ${DEFAULT_INITIATIVE_EVERY_MINUTES} を使う`,
        );
      } else if (parsed > SCHEDULE_EVERY_MINUTES_MAX) {
        // 上限はクローンの道具の `every` と揃える（#4723）: 上限が無いと次の発火時刻が Invalid Date になり、tick が約1ms周期で連射されるため
        notes.push(
          `ALTEROID_INITIATIVE_EVERY="${rawEvery}" は上限 ${SCHEDULE_EVERY_MINUTES_MAX} 分（1年）を超えているので既定 ${DEFAULT_INITIATIVE_EVERY_MINUTES} を使う`,
        );
      } else {
        initiativeEveryMinutes = parsed;
        // 整数でない値は起動側（`selfInitiativeEntry`）が切り捨てる: 黙って別の周期で動かさず、実際に使う値を言う。
        if (!Number.isInteger(parsed)) {
          notes.push(
            `ALTEROID_INITIATIVE_EVERY="${rawEvery}" は整数でないので ${Math.floor(parsed)} 分として扱う`,
          );
        }
      }
    }
  }

  const rawLookback = placedEnvValue(env, 'ALTEROID_REPORT_LOOKBACK_DAYS');
  let reportLookbackDays = DEFAULT_REPORT_LOOKBACK_DAYS;
  if (rawLookback !== null) {
    const parsed = Number(rawLookback);
    if (!Number.isFinite(parsed) || parsed < 0) {
      notes.push(
        `ALTEROID_REPORT_LOOKBACK_DAYS="${rawLookback}" は日数として読めないので既定 ${DEFAULT_REPORT_LOOKBACK_DAYS} を使う`,
      );
    } else if (parsed > MAX_REPORT_LOOKBACK_DAYS) {
      notes.push(
        `ALTEROID_REPORT_LOOKBACK_DAYS="${rawLookback}" は上限 ${MAX_REPORT_LOOKBACK_DAYS} 日を超えているので既定 ${DEFAULT_REPORT_LOOKBACK_DAYS} を使う`,
      );
    } else {
      reportLookbackDays = Math.floor(parsed);
    }
  }

  return { dailyReportAt, initiativeEveryMinutes, memoryTidyAt, reportLookbackDays, notes };
}

export function buildSchedule(config: ScheduleConfig): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  if (config.dailyReportAt !== null) {
    entries.push(dailyReportEntry({ at: config.dailyReportAt }));
  }
  if (config.initiativeEveryMinutes !== null) {
    entries.push(selfInitiativeEntry({ everyMinutes: config.initiativeEveryMinutes }));
  }
  if (config.memoryTidyAt !== null) {
    entries.push(memoryTidyEntry({ at: config.memoryTidyAt }));
  }
  return entries;
}
