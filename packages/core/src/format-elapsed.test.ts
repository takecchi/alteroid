import { describe, expect, it } from 'vitest';
import { formatMinutesAgo } from './format-elapsed.js';

const MIN = 60_000;

describe('formatMinutesAgo', () => {
  it.each([
    [-5 * MIN, '1分未満前'],
    [0, '1分未満前'],
    [59_999, '1分未満前'],
    [MIN, '1分前'],
    [59 * MIN + 59_999, '59分前'],
    [60 * MIN, '1時間0分前'],
    [276 * MIN, '4時間36分前'],
    [23 * 60 * MIN + 59 * MIN, '23時間59分前'],
    [24 * 60 * MIN, '1日0時間前'],
    [(2 * 24 + 5) * 60 * MIN + 7 * MIN, '2日5時間前'],
  ])('%i ms は「%s」', (elapsedMs, expected) => {
    expect(formatMinutesAgo(elapsedMs)).toBe(expected);
  });
});
