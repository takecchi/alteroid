import { DAILY_REPORT_KIND, SELF_INITIATIVE_KIND } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_INITIATIVE_EVERY_MINUTES, buildSchedule, readScheduleConfig } from './schedule.js';

/**
 * 既定は「動く」であること（常駐と自律は後から足す機能ではない）と、
 * 間隔が方針として開けられることの両方を固定する。
 */
describe('定期ジョブの設定', () => {
  it('何も設定しなくても日報と発意 tick が仕込まれる', () => {
    const config = readScheduleConfig({});

    expect(config.dailyReportAt).toEqual({ hour: 22, minute: 0 });
    expect(config.initiativeEveryMinutes).toBe(DEFAULT_INITIATIVE_EVERY_MINUTES);
    expect(config.notes).toEqual([]);
    expect(buildSchedule(config).map((entry) => entry.kind)).toEqual([
      DAILY_REPORT_KIND,
      SELF_INITIATIVE_KIND,
    ]);
  });

  it('締め時刻と間隔は人間が変えられる', () => {
    const config = readScheduleConfig({
      ALTEROID_DAILY_REPORT_AT: '07:30',
      ALTEROID_INITIATIVE_EVERY: '15',
      ALTEROID_REPORT_LOOKBACK_DAYS: '7',
    });

    expect(config.dailyReportAt).toEqual({ hour: 7, minute: 30 });
    expect(config.initiativeEveryMinutes).toBe(15);
    expect(config.reportLookbackDays).toBe(7);
    expect(config.notes).toEqual([]);
  });

  it('off で外せる（方針は設定で開けられなければならない、の裏返し）', () => {
    const config = readScheduleConfig({
      ALTEROID_DAILY_REPORT_AT: 'off',
      ALTEROID_INITIATIVE_EVERY: 'off',
    });

    expect(config.dailyReportAt).toBeNull();
    expect(config.initiativeEveryMinutes).toBeNull();
    expect(buildSchedule(config)).toEqual([]);
  });

  it('読めない値は黙って無視せず、既定へ落として人間に知らせる', () => {
    const config = readScheduleConfig({
      ALTEROID_DAILY_REPORT_AT: 'あさ',
      ALTEROID_INITIATIVE_EVERY: '-3',
    });

    expect(config.dailyReportAt).toEqual({ hour: 22, minute: 0 });
    expect(config.initiativeEveryMinutes).toBe(DEFAULT_INITIATIVE_EVERY_MINUTES);
    expect(config.notes).toHaveLength(2);
  });

  it('空文字は「未指定」として扱う（CLI 側の解釈と揃える）', () => {
    const config = readScheduleConfig({ ALTEROID_DAILY_REPORT_AT: '  ' });
    expect(config.dailyReportAt).toEqual({ hour: 22, minute: 0 });
    expect(config.notes).toEqual([]);
  });
});
