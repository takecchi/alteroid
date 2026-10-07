import { isRealUsageDate, USAGE_DATE_PATTERN } from '@alteroid/core/usage';
import { describe, expect, it } from 'vitest';

import { parseUsageDate } from './usage';

const CASES = [
  '2026-08-01',
  '0001-01-01',
  '9999-12-31',
  '2024-02-29',
  '2026-02-30',
  '2026-13-01',
  '2026-00-00',
  '2023-02-29',
  '',
  'not-a-date',
  '2026-8-1',
  '2026/08/01',
  '2026-08-01T00:00:00.000Z',
  '2026-08-011',
  '02026-08-01',
  ' 2026-08-01',
  '2026-08-01 ',
  '2026-08-01\n',
  '20260801',
] as const;

describe('画面の parseUsageDate が core の USAGE_DATE_PATTERN / isRealUsageDate へそのまま委譲している（issue #2133 / #2156 / #2166）', () => {
  it.each(CASES)('%s の判定が core から素朴に導ける期待値と一致する', (value) => {
    const expected = USAGE_DATE_PATTERN.test(value) && isRealUsageDate(value) ? value : '';
    expect(parseUsageDate(value)).toBe(expected);
  });

  it('raw が null または空文字なら core を呼ぶまでもなく空文字を返す', () => {
    expect(parseUsageDate(null)).toBe('');
    expect(parseUsageDate('')).toBe('');
  });
});
