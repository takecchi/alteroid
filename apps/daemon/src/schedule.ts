import {
  dailyReportEntry,
  parseTimeOfDay,
  selfInitiativeEntry,
  type ScheduleEntry,
  type TimeOfDay,
} from '@alteroid/core';

/**
 * デーモンに仕込む定期ジョブの設定。
 *
 * **既定は「動く」である。** 常駐と自律は後から足す機能ではないので、何も設定
 * しなくても日報と発意 tick は回る（PRD「自律」「可観測性」）。
 *
 * 間隔と締め時刻は方針なので設定で変えられ、`off` で外すこともできる。ただしこれは
 * 「暴走が怖いから回数を絞る」ための旋盤ではない — 抑止は実行環境の境界で行う
 * （north_star 禁止2 / AGENTS.md 地雷2）。
 */
export interface ScheduleConfig {
  /** 日報の締め時刻（ローカル時刻）。null なら日報を仕込まない。 */
  dailyReportAt: TimeOfDay | null;
  /** 発意 tick の間隔（分）。null なら仕込まない。 */
  initiativeEveryMinutes: number | null;
  /** 起動時に、取りこぼした日報を何日前まで遡って作るか。 */
  reportLookbackDays: number;
  /** 読めなかった設定値についての注意（呼び出し元が人間に見せる）。 */
  notes: string[];
}

export const DEFAULT_DAILY_REPORT_AT = '22:00';
export const DEFAULT_INITIATIVE_EVERY_MINUTES = 60;
export const DEFAULT_REPORT_LOOKBACK_DAYS = 3;

const OFF = new Set(['off', 'none', 'false', '0']);

export function readScheduleConfig(env: NodeJS.ProcessEnv = process.env): ScheduleConfig {
  const notes: string[] = [];

  const rawAt = value(env.ALTEROID_DAILY_REPORT_AT);
  let dailyReportAt: TimeOfDay | null = parseTimeOfDay(DEFAULT_DAILY_REPORT_AT);
  if (rawAt !== undefined) {
    if (OFF.has(rawAt.toLowerCase())) {
      dailyReportAt = null;
    } else {
      const parsed = parseTimeOfDay(rawAt);
      if (parsed === null) {
        notes.push(
          `ALTEROID_DAILY_REPORT_AT="${rawAt}" は HH:MM として読めないので既定 ${DEFAULT_DAILY_REPORT_AT} を使う`,
        );
      } else {
        dailyReportAt = parsed;
      }
    }
  }

  const rawEvery = value(env.ALTEROID_INITIATIVE_EVERY);
  let initiativeEveryMinutes: number | null = DEFAULT_INITIATIVE_EVERY_MINUTES;
  if (rawEvery !== undefined) {
    if (OFF.has(rawEvery.toLowerCase())) {
      initiativeEveryMinutes = null;
    } else {
      const parsed = Number(rawEvery);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        notes.push(
          `ALTEROID_INITIATIVE_EVERY="${rawEvery}" は分数として読めないので既定 ${DEFAULT_INITIATIVE_EVERY_MINUTES} を使う`,
        );
      } else {
        initiativeEveryMinutes = parsed;
      }
    }
  }

  const rawLookback = value(env.ALTEROID_REPORT_LOOKBACK_DAYS);
  let reportLookbackDays = DEFAULT_REPORT_LOOKBACK_DAYS;
  if (rawLookback !== undefined) {
    const parsed = Number(rawLookback);
    if (!Number.isFinite(parsed) || parsed < 0) {
      notes.push(
        `ALTEROID_REPORT_LOOKBACK_DAYS="${rawLookback}" は日数として読めないので既定 ${DEFAULT_REPORT_LOOKBACK_DAYS} を使う`,
      );
    } else {
      reportLookbackDays = Math.floor(parsed);
    }
  }

  return { dailyReportAt, initiativeEveryMinutes, reportLookbackDays, notes };
}

export function buildSchedule(config: ScheduleConfig): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  if (config.dailyReportAt !== null) {
    entries.push(dailyReportEntry({ at: config.dailyReportAt }));
  }
  if (config.initiativeEveryMinutes !== null) {
    entries.push(selfInitiativeEntry({ everyMinutes: config.initiativeEveryMinutes }));
  }
  return entries;
}

function value(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}
