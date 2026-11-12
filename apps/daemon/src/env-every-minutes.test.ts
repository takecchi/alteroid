import { describe, expect, it } from 'vitest';

import { clampedIntervalMs, MAX_TIMER_DELAY_MS, readEveryMinutes } from './env-every-minutes.js';

describe('clampedIntervalMs（setTimeout の上限で頭打ちにする）', () => {
  it('差し替えが無ければ分からミリ秒を作る', () => {
    expect(clampedIntervalMs(undefined, 60)).toBe(3_600_000);
  });

  it('差し替え（intervalMs）が在れば分より優先する', () => {
    expect(clampedIntervalMs(50, 60)).toBe(50);
  });

  it('2^31-1 ms を超える値は頭打ちにする（超えると setTimeout が 1ms へ倒れる）', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
    expect(clampedIntervalMs(undefined, 40_000)).toBe(2_147_483_647);
    expect(clampedIntervalMs(2 ** 40, 1)).toBe(2_147_483_647);
  });
});

describe('readEveryMinutes（注意文の全文・既定・範囲・off の綴りを固定する）', () => {
  const KEY = 'ALTEROID_TEST_EVERY';
  const bounded = {
    defaultMinutes: 55,
    minMinutes: 2,
    max: { minutes: 100, text: '100 分（上限）' },
    noteNonInteger: true,
  };
  const read = (raw: string | undefined, spec: Parameters<typeof readEveryMinutes>[2] = bounded) =>
    readEveryMinutes(raw === undefined ? {} : { [KEY]: raw }, KEY, spec);

  it('未設定・空・空白だけは、知らせずに既定', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(read(raw)).toEqual({ everyMinutes: 55, notes: [] });
    }
  });

  it('止める綴り（大文字小文字を問わず・前後の空白は無視）は null で、知らせない', () => {
    for (const raw of ['off', 'OFF', 'none', 'false', '0', 'no', 'disabled', '  off  ']) {
      expect(read(raw), raw).toEqual({ everyMinutes: null, notes: [] });
    }
  });

  it('読めない値と 0 以下（止める綴りの 0 を除く）は、分数として読めないと言って既定へ', () => {
    for (const raw of ['soon', '-3', '-0.5', 'NaN', 'Infinity', '-Infinity', '1,5']) {
      expect(read(raw), raw).toEqual({
        everyMinutes: 55,
        notes: [`${KEY}="${raw}" は分数として読めないので既定 55 を使う`],
      });
    }
    expect(read('  soon  ').notes).toEqual([
      `${KEY}="soon" は分数として読めないので既定 55 を使う`,
    ]);
  });

  it('下限を下回る値は、切り上げずに下限の断りつきで既定へ。下限ちょうどは採る', () => {
    expect(read('1.999')).toEqual({
      everyMinutes: 55,
      notes: [`${KEY}="1.999" は下限 2 分を下回っているので既定 55 を使う`],
    });
    expect(read('0.5').notes).toEqual([`${KEY}="0.5" は下限 2 分を下回っているので既定 55 を使う`]);
    expect(read('2')).toEqual({ everyMinutes: 2, notes: [] });
  });

  it('上限を超える値は、上限の断りつきで既定へ。上限ちょうどは採る。上限の指定が無ければ超えても採る', () => {
    expect(read('100.5')).toEqual({
      everyMinutes: 55,
      notes: [`${KEY}="100.5" は上限 100 分（上限） を超えているので既定 55 を使う`],
    });
    expect(read('1e12').notes).toEqual([
      `${KEY}="1e12" は上限 100 分（上限） を超えているので既定 55 を使う`,
    ]);
    expect(read('100')).toEqual({ everyMinutes: 100, notes: [] });
    expect(read('1e12', { defaultMinutes: 55, minMinutes: 2 })).toEqual({
      everyMinutes: 1e12,
      notes: [],
    });
  });

  it('noteNonInteger: 範囲内の小数は値を保ったまま、切り捨てた値を言う。整数と、指定が無いときは黙る', () => {
    expect(read('59.9')).toEqual({
      everyMinutes: 59.9,
      notes: [`${KEY}="59.9" は整数でないので 59 分として扱う`],
    });
    expect(read('7')).toEqual({ everyMinutes: 7, notes: [] });
    expect(read('59.9', { defaultMinutes: 55, minMinutes: 2 })).toEqual({
      everyMinutes: 59.9,
      notes: [],
    });
    // 範囲外の小数は「整数でない」とは言わない（既定へ倒れた理由だけ）
    expect(read('1.5').notes).toEqual([`${KEY}="1.5" は下限 2 分を下回っているので既定 55 を使う`]);
    // 既定そのものが小数でも、倒れたときは「整数でない」を重ねない
    expect(read('soon', { ...bounded, defaultMinutes: 2.5 })).toEqual({
      everyMinutes: 2.5,
      notes: [`${KEY}="soon" は分数として読めないので既定 2.5 を使う`],
    });
  });
});
