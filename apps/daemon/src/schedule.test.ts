import { DAILY_REPORT_KIND, MEMORY_TIDY_KIND, SELF_INITIATIVE_KIND } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { DEFAULT_INITIATIVE_EVERY_MINUTES, buildSchedule, readScheduleConfig } from './schedule.js';

/**
 * 既定は「動く」であること（常駐と自律は後から足す機能ではない）と、
 * 間隔が方針として開けられることの両方を固定する。
 */
describe('定期ジョブの設定', () => {
  /**
   * **記憶の棚卸し（`MEMORY_TIDY_KIND`）を 2026-09-08 に足した。**
   * かつてここは組み込みが2つであることを固定していた。**測っているもの
   * （何も設定しなくても組み込みが仕込まれる）は変わっていない** —— 数えている
   * 対象が1つ増えた。**一覧そのものを比べる形は残す**（`toEqual` を
   * `toContain` へ緩めない。緩めると、順序が変わっても増えても落ちなくなる）。
   */
  it('何も設定しなくても日報・発意 tick・記憶の棚卸しが仕込まれる', () => {
    const config = readScheduleConfig({});

    expect(config.dailyReportAt).toEqual({ hour: 22, minute: 0 });
    expect(config.initiativeEveryMinutes).toBe(DEFAULT_INITIATIVE_EVERY_MINUTES);
    expect(config.memoryTidyAt).toEqual({ hour: 3, minute: 0 });
    expect(config.notes).toEqual([]);
    expect(buildSchedule(config).map((entry) => entry.kind)).toEqual([
      DAILY_REPORT_KIND,
      SELF_INITIATIVE_KIND,
      MEMORY_TIDY_KIND,
    ]);
  });

  /**
   * ⭐ **棚卸しは日報と同じ時刻に置かない**（`ScheduleConfig.memoryTidyAt` の doc）。
   * 既定どうしが重なっていないことを、値を書き写さずに確かめる。
   */
  it('棚卸しの既定時刻は日報の既定時刻と重ならない', () => {
    const config = readScheduleConfig({});
    expect(config.memoryTidyAt).not.toEqual(config.dailyReportAt);
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
      ALTEROID_MEMORY_TIDY_AT: 'off',
    });

    expect(config.dailyReportAt).toBeNull();
    expect(config.initiativeEveryMinutes).toBeNull();
    expect(config.memoryTidyAt).toBeNull();
    expect(buildSchedule(config)).toEqual([]);
  });

  /**
   * ⭐ **1つずつ外せる。** 上の歯は3つまとめて外しているので、「どれか1つの
   * off が全部を外す」実装が生存しうる（実際に `buildSchedule` は3本の独立した
   * `if` である）。1つだけ外して、残りが仕込まれたままであることを見る。
   */
  it('棚卸しだけを off にしても、日報と発意 tick は残る', () => {
    const config = readScheduleConfig({ ALTEROID_MEMORY_TIDY_AT: 'off' });

    expect(config.memoryTidyAt).toBeNull();
    expect(buildSchedule(config).map((entry) => entry.kind)).toEqual([
      DAILY_REPORT_KIND,
      SELF_INITIATIVE_KIND,
    ]);
  });

  it('棚卸しの時刻も人間が変えられる。読めない値は既定へ落として知らせる', () => {
    expect(readScheduleConfig({ ALTEROID_MEMORY_TIDY_AT: '05:30' }).memoryTidyAt).toEqual({
      hour: 5,
      minute: 30,
    });

    const broken = readScheduleConfig({ ALTEROID_MEMORY_TIDY_AT: 'よる' });
    expect(broken.memoryTidyAt).toEqual({ hour: 3, minute: 0 });
    expect(broken.notes).toHaveLength(1);
    expect(broken.notes[0]).toContain('ALTEROID_MEMORY_TIDY_AT');
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
