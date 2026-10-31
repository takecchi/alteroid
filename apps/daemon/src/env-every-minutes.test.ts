import { describe, expect, it } from 'vitest';

import { clampedIntervalMs, MAX_TIMER_DELAY_MS } from './env-every-minutes.js';

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
