import { afterAll, describe, expect, it, vi } from 'vitest';

// beforeAll ではなく `vi.hoisted` で固定する: `format.ts` は読み込み時に `Intl.DateTimeFormat` を作り、TZ はその時点で捕まるため。
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

import {
  describeMemoryDescriptionDrift,
  formatBytes,
  formatDateTime,
  formatRelative,
} from './format.js';

const NOW = Date.parse('2026-08-13T12:00:00Z');

describe('formatRelative', () => {
  it('直近は「たった今」', () => {
    expect(formatRelative('2026-08-13T11:59:40Z', NOW)).toBe('たった今');
  });

  it('分・時間・日で丸める', () => {
    expect(formatRelative('2026-08-13T11:50:00Z', NOW)).toBe('10分前');
    expect(formatRelative('2026-08-13T09:00:00Z', NOW)).toBe('3時間前');
    expect(formatRelative('2026-08-11T12:00:00Z', NOW)).toBe('2日前');
  });

  it('now が読めないときは「NaN日前」にせず iso をそのまま返す（#3966）', () => {
    expect(formatRelative('2026-08-13T11:59:40Z', Number.NaN)).toBe('2026-08-13T11:59:40Z');
  });

  it('丸めた後の値で単位を上げる（#3609）', () => {
    const ago = (s: number) => formatRelative(new Date(NOW - s * 1000).toISOString(), NOW);
    expect(ago(3569)).toBe('59分前');
    expect(ago(3570)).toBe('1時間前');
    expect(ago(3599)).toBe('1時間前');
    expect(ago(84599)).toBe('23時間前');
    expect(ago(84600)).toBe('1日前');
    expect(ago(86399)).toBe('1日前');
    expect(formatRelative(new Date(NOW + 3590 * 1000).toISOString(), NOW)).toBe('1時間後');
  });

  it('未来（次の発火時刻）も表せる', () => {
    expect(formatRelative('2026-08-13T13:00:00Z', NOW)).toBe('1時間後');
  });

  it('解釈できない値はそのまま返す（握り潰して Invalid Date を出さない）', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('not-a-date');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatDateTime', () => {
  it('今年の時刻には年を付けない（直す前と1文字も変わらない見た目）', () => {
    expect(formatDateTime('2026-08-13T07:00:00Z', NOW)).toBe('08/13 16:00');
  });

  it('去年の時刻には年を付ける', () => {
    expect(formatDateTime('2025-08-13T07:00:00Z', NOW)).toBe('2025/08/13 16:00');
  });

  it('年の変わり目は UTC の日付ではなく閲覧者の端末（TZ=Asia/Tokyo）の12/31・1/1で切り替わる', () => {
    const nowJustAfterNewYear = Date.parse('2026-01-01T00:30:00Z');

    expect(formatDateTime('2025-12-31T14:59:00Z', nowJustAfterNewYear)).toBe('2025/12/31 23:59');

    expect(formatDateTime('2025-12-31T15:00:00Z', nowJustAfterNewYear)).toBe('01/01 00:00');
  });
});

describe('formatBytes', () => {
  it('単位を切り替える', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('丸めた後の値で単位を上げる（#3609）', () => {
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1048524)).toBe('1023.9 KB');
    expect(formatBytes(1048525)).toBe('1.0 MB');
    expect(formatBytes(1048575)).toBe('1.0 MB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });
});

describe('describeMemoryDescriptionDrift', () => {
  it('measured は %つきで出す', () => {
    expect(
      describeMemoryDescriptionDrift({
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1200,
        deltaBytes: 200,
      }),
    ).toBe('本文は+200バイト（+20%）変わった');
  });

  it('at-least は %を出さず、baselineAt も刷らない。measured / unrecorded とは別の言葉になる（#821 残課題）', () => {
    const atLeast = describeMemoryDescriptionDrift({
      kind: 'at-least',
      baselineBytes: 1000,
      baselineAt: '2026-08-20T12:00:00Z',
      currentBytes: 1200,
      deltaBytes: 200,
    });
    const measured = describeMemoryDescriptionDrift({
      kind: 'measured',
      describedBytes: 1000,
      currentBytes: 1200,
      deltaBytes: 200,
    });
    const unrecorded = describeMemoryDescriptionDrift({ kind: 'unrecorded' });

    expect(atLeast).toBe('+200バイト以上変わった');
    expect(atLeast).not.toContain('%');
    expect(atLeast).not.toContain('2026-08-20T12:00:00Z');
    expect(atLeast).not.toBe(measured);
    expect(atLeast).not.toBe(unrecorded);
  });

  it('unrecorded は「記録されていない」と言う（0バイトと混ぜない）', () => {
    expect(describeMemoryDescriptionDrift({ kind: 'unrecorded' })).toBe(
      '本文の変化量は記録されていない',
    );
  });
});
