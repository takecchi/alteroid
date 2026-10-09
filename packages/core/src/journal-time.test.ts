import { describe, expect, it } from 'vitest';

import {
  describeUnreadableJournalTimeBoundary,
  isOffsetQualifiedTimeBoundary,
  isReadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
} from './journal-time.js';

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

// 正規化の値を assert するのは時差つきと日付だけ: 時差なしの日時は実行環境の地方時刻で読まれ、TZ に依るため。
describe('isReadableJournalTimeBoundary（#3287）', () => {
  it.each([
    '2026-10-06',
    '2026-10-06T09:00',
    '2026-10-06T09:00:00',
    '2026-10-06T09:00:00.123',
    '2026-10-06 09:00',
    '2026-10-06T09:00Z',
    '2026-10-06T09:00:00Z',
    '2026-10-06T09:00:00.123Z',
    '2026-10-06T09:00:00+09:00',
    '2026-10-06T09:00-05:00',
    '2024-02-29',
    '2026-09-12T20:21Z',
  ])('受け付ける形 %s は通す', (value) => {
    expect(isReadableJournalTimeBoundary(value)).toBe(true);
    expect(normalizeJournalTimeBoundary(value)).not.toBeNull();
  });

  it.each([
    'foo 1',
    '1',
    '12',
    'きのう',
    '',
    '2026-02-31',
    '2026-04-31',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-00',
    '2026-10-06T25:00',
    '2026-10-06T09:00:00+0900',
    '2026/10/06',
    'Sep 25 2026',
    '2026-10-06T09',
    '2026-10-06T',
    ' 2026-10-06',
    '2026-10-06T09:00:00Zjunk',
  ])('受け付けない形 %s は断る', (value) => {
    expect(isReadableJournalTimeBoundary(value)).toBe(false);
    expect(normalizeJournalTimeBoundary(value)).toBeNull();
  });

  it('時差つきの日時は従来どおり UTC へ正規化される（#2451）', () => {
    expect(normalizeJournalTimeBoundary('2026-10-06T09:00:00+09:00')).toBe(
      '2026-10-06T00:00:00.000Z',
    );
    expect(normalizeJournalTimeBoundary('2026-09-12T20:21Z')).toBe('2026-09-12T20:21:00.000Z');
    expect(normalizeJournalTimeBoundary('2026-09-13T05:21:00-05:00')).toBe(
      '2026-09-13T10:21:00.000Z',
    );
    expect(normalizeJournalTimeBoundary('2026-10-06')).toBe('2026-10-06T00:00:00.000Z');
  });

  it('断る文言に、受け付ける形の例が入る', () => {
    const message = describeUnreadableJournalTimeBoundary('since', 'foo 1');
    expect(message).toContain('since に渡された「foo 1」は日時として読めない');
    expect(message).toContain('2026-10-06');
    expect(message).toContain('2026-10-06T09:00');
    expect(message).toContain('2026-10-06T09:00:00+09:00');
  });
});
