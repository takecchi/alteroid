import {
  DAILY_REPORT_KIND,
  MEMORY_TIDY_KIND,
  RESERVED_SCHEDULE_KIND_ENV_KEYS,
  SELF_INITIATIVE_KIND,
  type ReservedScheduleKind,
} from '@alteroid/core';
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

/**
 * ⭐ **`RESERVED_SCHEDULE_KIND_ENV_KEYS`（`packages/core/src/schedule.ts`）が
 * 名前の対応しか持っていないことの、裏取りである。**
 *
 * あの表はクローンへ渡る断り文言（`schedule_create`）の出所になっている。
 * **だが表そのものは「その環境変数を daemon が本当に読んでいるか」を1バイトも
 * 知らない。** #701 以前の断り文言は、まさにそこで嘘をついていた ——
 * `schedule_create kind=memory_tidy` を打ったクローンへ、**実在しない対応**
 * （`ALTEROID_DAILY_REPORT_AT` / `ALTEROID_INITIATIVE_EVERY`）を案内していた。
 *
 * ⟹ **表の各行について、実際にその環境変数を置いて `readScheduleConfig` が
 * 反応することを確かめる。** 反応しなければ、その行は案内としては嘘である。
 *
 * ## ⚠️ この歯が測っていないこと
 *
 * - **「その環境変数が、その kind の刻みを動かす」ことまでは測っていない。**
 *   測っているのは「置くと `readScheduleConfig` の答えが既定から動く」ことだけで、
 *   `ALTEROID_MEMORY_TIDY_AT` が日報のほうを動かすような取り違えはここでは
 *   捕まらない（下の3本目の歯が、kind ごとの欄を名指しで見る形でそこを補う）
 * - **`compose.yaml` / `.env.example` / 本番の環境にその変数が在るかは見ていない**
 */
describe('予約 kind → 環境変数の対応が、実在する口を指している', () => {
  /** 対応表の各行について、既定から動く値を1つ用意する。 */
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
      // 読めない値として弾かれていたら、この歯は「動いた」を測れていない。
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
    // **既定の3本すべてが「読めない値」の注記に自分の名前を出す。** 名前が
    // 変われば、この注記に出てくる名前も変わる ＝ 表の側だけが古くなることを
    // ここで捕まえる。
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
