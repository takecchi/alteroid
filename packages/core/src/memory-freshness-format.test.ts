import { describe, expect, it } from 'vitest';

import { memoryFreshnessMarker } from './memory-freshness-format.js';

const HOUR = 60 * 60 * 1000;

describe('memoryFreshnessMarker（core と CLI が同じ1本を使う）', () => {
  it('stale は期間と変化量を出す（measured は % つき）', () => {
    expect(
      memoryFreshnessMarker({
        kind: 'stale',
        staleForMs: HOUR,
        drift: { kind: 'measured', describedBytes: 1000, currentBytes: 1200, deltaBytes: 200 },
      }),
    ).toBe('要旨は本文より1時間古い（本文は+200バイト（+20%）変わった）: ');
  });

  it('期間の単位は 秒・分・時間・日', () => {
    const unrecorded = { kind: 'unrecorded' } as const;
    const mark = (staleForMs: number) =>
      memoryFreshnessMarker({ kind: 'stale', staleForMs, drift: unrecorded });
    expect(mark(59_000)).toContain('59秒古い');
    expect(mark(60_000)).toContain('1分古い');
    expect(mark(HOUR)).toContain('1時間古い');
    expect(mark(30 * 24 * HOUR)).toContain('30日古い');
  });

  it('負の期間は0秒にする（HTTP 越しの値を型だけで信じない）', () => {
    expect(
      memoryFreshnessMarker({ kind: 'stale', staleForMs: -5000, drift: { kind: 'unrecorded' } }),
    ).toBe('要旨は本文より0秒古い（本文の変化量は記録されていない）: ');
  });

  it('describedBytes が 0 なら % を出さない。at-least は下限として言い、% も baselineAt も出さない', () => {
    expect(
      memoryFreshnessMarker({
        kind: 'stale',
        staleForMs: HOUR,
        drift: { kind: 'measured', describedBytes: 0, currentBytes: 10, deltaBytes: 10 },
      }),
    ).toContain('本文は+10バイト変わった');
    expect(
      memoryFreshnessMarker({
        kind: 'stale',
        staleForMs: HOUR,
        drift: {
          kind: 'at-least',
          baselineBytes: 1200,
          baselineAt: '2026-08-20T12:00:00Z',
          currentBytes: 1000,
          deltaBytes: -200,
        },
      }),
    ).toBe('要旨は本文より1時間古い（-200バイト以上変わった）: ');
  });

  it('fresh・unknown・absent はそれぞれ別の言葉（absent は何も出さない）', () => {
    expect(memoryFreshnessMarker({ kind: 'fresh' })).toBe('要旨の後に本文は動いていない: ');
    expect(memoryFreshnessMarker({ kind: 'unknown' })).toBe('要旨を書いた時刻が記録されていない: ');
    expect(memoryFreshnessMarker({ kind: 'absent' })).toBe('');
  });
});
