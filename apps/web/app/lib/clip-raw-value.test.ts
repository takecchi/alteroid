import { describe, expect, it } from 'vitest';

import { clipRawValue } from './clip-raw-value';

describe('clipRawValue', () => {
  it('40文字までは切らない', () => {
    expect(clipRawValue('')).toBe('');
    expect(clipRawValue('x'.repeat(40))).toBe('x'.repeat(40));
  });

  it('41文字からは40文字で切って「…」を付ける', () => {
    expect(clipRawValue('x'.repeat(41))).toBe(`${'x'.repeat(40)}…`);
  });

  it('コードポイントで数え、サロゲートペアの途中で切らない', () => {
    expect(clipRawValue('😀'.repeat(40))).toBe('😀'.repeat(40));
    expect(clipRawValue('😀'.repeat(41))).toBe(`${'😀'.repeat(40)}…`);
  });
});
