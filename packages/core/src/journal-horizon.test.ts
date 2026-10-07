import { describe, expect, it } from 'vitest';

import { journalWindowCrossesHorizon } from './journal-horizon.js';

describe('journalWindowCrossesHorizon（issue #1510 の積み残し）', () => {
  it('oldestAt が null（日誌が空）なら、since に関わらず常に偽', () => {
    expect(journalWindowCrossesHorizon(null, undefined)).toBe(false);
    expect(journalWindowCrossesHorizon(null, '2020-01-01T00:00:00.000Z')).toBe(false);
  });

  it('since が未指定（窓の始点 -∞）なら、地平が在る限り常に真', () => {
    expect(journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', undefined)).toBe(true);
  });

  it('since が地平以降なら偽（窓はまるごと地平より後ろ）', () => {
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-16T00:00:00.000Z'),
    ).toBe(false);
  });

  it('since がちょうど地平と同じ瞬間なら偽（start >= oldestAt の境界）', () => {
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z'),
    ).toBe(false);
  });

  it('since が地平より前なら真', () => {
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
    ).toBe(true);
  });

  it('since は時刻として比べる——秒省略・オフセット付きでも地平より前なら真', () => {
    expect(journalWindowCrossesHorizon('2026-08-15T00:05:30.000Z', '2026-08-15T00:04Z')).toBe(true);
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-15T08:00:00+09:00'),
    ).toBe(true);
  });

  it('since が読めない文字列なら、判定できない側（真）へ倒す', () => {
    expect(journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', 'not-a-datetime')).toBe(true);
  });
});
