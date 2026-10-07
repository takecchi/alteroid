import {
  DAILY_REPORT_KIND,
  MEMORY_TIDY_KIND,
  RESERVED_SCHEDULE_KIND_ENV_KEYS,
  SELF_INITIATIVE_KIND,
  type ReservedScheduleKind,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INITIATIVE_EVERY_MINUTES,
  MIN_INITIATIVE_EVERY_MINUTES,
  buildSchedule,
  readScheduleConfig,
} from './schedule.js';

describe('定期ジョブの設定', () => {
  // `toEqual` を `toContain` へ緩めない: 緩めると、順序が変わっても増えても落ちなくなるため。
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

  it('自発の起動の周期は、下限（1分）未満なら notes へ落として既定へ倒す。下限ちょうどと小数は採用する（#4014）', () => {
    const read = (raw: string) => readScheduleConfig({ ALTEROID_INITIATIVE_EVERY: raw });
    expect(MIN_INITIATIVE_EVERY_MINUTES).toBe(1);
    for (const ok of ['1', '1.5']) {
      const config = read(ok);
      expect(config.initiativeEveryMinutes).toBe(Number(ok));
      expect(config.notes).toEqual([]);
    }
    for (const low of ['0.00001', '0.999999', '-5', 'soon']) {
      const config = read(low);
      expect(config.initiativeEveryMinutes).toBe(DEFAULT_INITIATIVE_EVERY_MINUTES);
      expect(config.notes).toHaveLength(1);
      expect(config.notes[0]).toContain(`"${low}"`);
    }
    expect(read('0.00001').notes[0]).toBe(
      'ALTEROID_INITIATIVE_EVERY="0.00001" は下限 1 分を下回っているので既定 55 を使う',
    );
    expect(read('0').initiativeEveryMinutes).toBeNull();
    expect(read('0').notes).toEqual([]);
  });

  it('空文字は「未指定」として扱う（CLI 側の解釈と揃える）', () => {
    const config = readScheduleConfig({ ALTEROID_DAILY_REPORT_AT: '  ' });
    expect(config.dailyReportAt).toEqual({ hour: 22, minute: 0 });
    expect(config.notes).toEqual([]);
  });
});

describe('予約 kind → 環境変数の対応が、実在する口を指している', () => {
  const PROBE: Readonly<Record<ReservedScheduleKind, string>> = {
    [DAILY_REPORT_KIND]: '05:30',
    [SELF_INITIATIVE_KIND]: '7',
    [MEMORY_TIDY_KIND]: '01:15',
  };

  it('表の全行について、その環境変数を置くと readScheduleConfig の答えが動く', () => {
    const base = readScheduleConfig({});
    for (const [kind, envKey] of Object.entries(RESERVED_SCHEDULE_KIND_ENV_KEYS)) {
      const probe = PROBE[kind as ReservedScheduleKind];
      const config = readScheduleConfig({ [envKey]: probe });
      expect(config.notes, `${envKey}="${probe}" が読めない値として弾かれた`).toEqual([]);
      expect(
        JSON.stringify(config),
        `【赤の意味】${kind} に対応づけた ${envKey} を置いても readScheduleConfig の答えが` +
          '1バイトも動かない。この環境変数は実在しないか、もう読まれていない——' +
          'RESERVED_SCHEDULE_KIND_ENV_KEYS（packages/core/src/schedule.ts）の行が嘘になっている',
      ).not.toBe(JSON.stringify(base));
    }
  });

  it('表に載っている環境変数の名前が、この repo の読み手と一致している', () => {
    for (const [, envKey] of Object.entries(RESERVED_SCHEDULE_KIND_ENV_KEYS)) {
      const config = readScheduleConfig({ [envKey]: 'よめない' });
      expect(config.notes.join('\n'), `${envKey} を置いても注記に名前が出ない`).toContain(envKey);
    }
  });

  it('kind と環境変数が取り違えられていない（動く欄が kind ごとに違う）', () => {
    const daily = readScheduleConfig({
      [RESERVED_SCHEDULE_KIND_ENV_KEYS[DAILY_REPORT_KIND]]: '05:30',
    });
    expect(daily.dailyReportAt).toEqual({ hour: 5, minute: 30 });
    expect(daily.memoryTidyAt).toEqual({ hour: 3, minute: 0 });

    const tidy = readScheduleConfig({
      [RESERVED_SCHEDULE_KIND_ENV_KEYS[MEMORY_TIDY_KIND]]: '01:15',
    });
    expect(tidy.memoryTidyAt).toEqual({ hour: 1, minute: 15 });
    expect(tidy.dailyReportAt).toEqual({ hour: 22, minute: 0 });

    const initiative = readScheduleConfig({
      [RESERVED_SCHEDULE_KIND_ENV_KEYS[SELF_INITIATIVE_KIND]]: '7',
    });
    expect(initiative.initiativeEveryMinutes).toBe(7);
    expect(initiative.dailyReportAt).toEqual({ hour: 22, minute: 0 });
  });
});
