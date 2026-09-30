import { describe, expect, it } from 'vitest';

import { isOffsetQualifiedTimeBoundary, isReadableJournalTimeBoundary } from './journal-time.js';

/**
 * `isOffsetQualifiedTimeBoundary`（#2462）。元に戻せない一括操作の門なので、
 * 時差の無い形（`Date.parse` がサーバーの地方時刻として読む形）を断る。
 */
describe('isOffsetQualifiedTimeBoundary', () => {
  it.each([
    '2026-09-12T20:21Z',
    '2026-09-12T20:21:00Z',
    '2026-09-12T20:21:00.123+09:00',
    '2026-09-12T20:21-05:00',
  ])('時差の付いた %s は通す', (value) => {
    expect(isOffsetQualifiedTimeBoundary(value)).toBe(true);
  });

  it.each([
    '2026-09-25T19:00',
    '2026-09-25T19:00:00',
    '2026/09/25',
    'Sep 25 2026',
    '2026-09-25',
    '2026-09-25 19:00Z',
    '2026-09-25T19:00+0900',
    '2026-09-25T25:99Z',
    'きのう',
    '',
  ])('%s は断る', (value) => {
    expect(isOffsetQualifiedTimeBoundary(value)).toBe(false);
  });

  it('時差の無い形は、読むだけの口の門（isReadableJournalTimeBoundary）では通ったままである', () => {
    expect(isReadableJournalTimeBoundary('2026-09-25T19:00')).toBe(true);
  });
});
