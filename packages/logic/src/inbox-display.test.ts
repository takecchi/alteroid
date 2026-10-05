import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  INBOX_TYPE_LABEL,
  INBOX_TYPES,
  inboxSourceLabel,
  inboxTypeLabel,
  localDateTimeToIso,
} from './inbox-display.js';

const tzBefore = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Tokyo';
});
afterAll(() => {
  if (tzBefore === undefined) delete process.env.TZ;
  else process.env.TZ = tzBefore;
});

describe('inboxTypeLabel', () => {
  it('7種類すべてに識別子を含まない日本語名がある', () => {
    expect(INBOX_TYPES).toHaveLength(7);
    for (const type of INBOX_TYPES) {
      expect(INBOX_TYPE_LABEL[type]).not.toMatch(/[a-z_]{4,}/);
    }
  });
  it('知らない種類は識別子を出さない', () => {
    expect(inboxTypeLabel('draining')).toBe('その他の種類');
    expect(inboxTypeLabel('constructor')).toBe('その他の種類');
  });
});

describe('inboxSourceLabel', () => {
  it('接頭辞を日本語にする', () => {
    expect(inboxSourceLabel('external:foo')).toBe('外部「foo」');
    expect(inboxSourceLabel('manager:mgr-1')).toBe('マネージャー「mgr-1」');
    expect(inboxSourceLabel('x')).toBe('x');
  });
});

describe('localDateTimeToIso（TZ=Asia/Tokyo）', () => {
  it('利用者の地域の時刻を UTC の ISO へ変える（日付をまたぐ）', () => {
    expect(localDateTimeToIso('2026-09-15T00:00')).toBe('2026-09-14T15:00:00.000Z');
    expect(localDateTimeToIso('2026-09-15T09:30')).toBe('2026-09-15T00:30:00.000Z');
  });
  it('空・読めない値は undefined', () => {
    expect(localDateTimeToIso('')).toBeUndefined();
    expect(localDateTimeToIso('  ')).toBeUndefined();
    expect(localDateTimeToIso('abc')).toBeUndefined();
  });
});
