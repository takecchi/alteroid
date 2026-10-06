import { describe, expect, it } from 'vitest';

import { nonBlankString } from './non-blank-string.js';

/**
 * `nonBlankString` の「空」の検査は、ストアが NUL を落として残すので、NUL を落とした後で行う
 * （#3361 / #3384 / #3388 と同じ形。issue #3434）。値は書き換えない（検査だけ）。
 */
describe('nonBlankString が NUL だけ・NUL と空白だけを通す', () => {
  it.each(['\u0000', '\u0000\u0000', ' \u0000 ', '\u0000\n'])('%j を断る', (value) => {
    expect(nonBlankString.safeParse(value).success).toBe(false);
  });

  it('空文字・空白だけは今までどおり断る', () => {
    expect(nonBlankString.safeParse('').success).toBe(false);
    expect(nonBlankString.safeParse('  \n').success).toBe(false);
  });

  it.each(['a\u0000', '\u0000a', 'a\u0000b', ' \u0000x\u0000 '])(
    'NUL が混じっても中身が残る %j は通し、値を書き換えない',
    (value) => {
      const parsed = nonBlankString.safeParse(value);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toBe(value);
    },
  );
});
