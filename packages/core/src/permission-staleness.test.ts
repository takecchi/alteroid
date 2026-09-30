import { describe, expect, it } from 'vitest';

import {
  PERMISSION_GRANT_STALE_DAYS,
  assessPermissionGrantStaleness,
} from './permission-staleness.js';

const NOW = new Date('2026-09-30T00:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('assessPermissionGrantStaleness', () => {
  it('閾値は 45 日', () => {
    expect(PERMISSION_GRANT_STALE_DAYS).toBe(45);
  });

  it('境界: 44 日は対象外、45 日ちょうどと 46 日は対象', () => {
    const at = (days: number) =>
      assessPermissionGrantStaleness({ grantedAt: daysAgo(200), lastUsedAt: daysAgo(days) }, NOW);
    expect(at(44)).toMatchObject({ stale: false, idleDays: 44 });
    expect(at(45)).toMatchObject({ stale: true, idleDays: 45 });
    expect(at(46)).toMatchObject({ stale: true, idleDays: 46 });
  });

  it('起点は lastUsedAt。無ければ grantedAt', () => {
    expect(
      assessPermissionGrantStaleness({ grantedAt: daysAgo(100), lastUsedAt: daysAgo(3) }, NOW),
    ).toEqual({ stale: false, idleDays: 3, basis: 'lastUsedAt' });
    expect(assessPermissionGrantStaleness({ grantedAt: daysAgo(100) }, NOW)).toEqual({
      stale: true,
      idleDays: 100,
      basis: 'grantedAt',
    });
    expect(assessPermissionGrantStaleness({ grantedAt: daysAgo(44) }, NOW).stale).toBe(false);
    expect(assessPermissionGrantStaleness({ grantedAt: daysAgo(45) }, NOW).stale).toBe(true);
  });

  it('取り消し済みは対象外（日数は数える）', () => {
    expect(
      assessPermissionGrantStaleness({ grantedAt: daysAgo(100), revokedAt: daysAgo(1) }, NOW),
    ).toEqual({ stale: false, idleDays: 100, basis: 'grantedAt' });
  });

  it('lastUsedAt が grantedAt より新しくても lastUsedAt を起点にする', () => {
    expect(
      assessPermissionGrantStaleness({ grantedAt: daysAgo(90), lastUsedAt: daysAgo(10) }, NOW),
    ).toMatchObject({ stale: false, idleDays: 10 });
  });

  it('起点が未来（時計のずれ）でも 0 日で落ちない', () => {
    expect(assessPermissionGrantStaleness({ grantedAt: daysAgo(-2) }, NOW)).toMatchObject({
      stale: false,
      idleDays: 0,
    });
  });
});
