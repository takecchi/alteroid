import { describe, expect, it } from 'vitest';

import {
  addUsageTotals,
  compareUsageRows,
  compareUsageTurnRows,
  compareUsageUnmeteredRows,
  matchesUsageQuery,
  usageBaselineKey,
  usageRowKey,
  usageTurnKey,
  usageUnmeteredKey,
} from './usage-ledger-query.js';
import { ZERO_USAGE } from './usage-format.js';
import type { UsageTurnRow } from './usage.js';

const row = {
  date: '2026-08-12',
  managerId: 'm1',
  layer: 'manager',
  site: 'session',
  tokenId: 't1',
};

describe('matchesUsageQuery', () => {
  it('条件が無ければ当たり、期間は両端を含む', () => {
    expect(matchesUsageQuery(row, {})).toBe(true);
    expect(matchesUsageQuery(row, { from: '2026-08-12', to: '2026-08-12' })).toBe(true);
    expect(matchesUsageQuery(row, { from: '2026-08-13' })).toBe(false);
    expect(matchesUsageQuery(row, { to: '2026-08-11' })).toBe(false);
  });

  it('担当・層・場所・鍵のどれか1つでも違えば外れる', () => {
    expect(matchesUsageQuery(row, { managerId: 'm2' })).toBe(false);
    expect(matchesUsageQuery(row, { layer: 'clone' })).toBe(false);
    expect(matchesUsageQuery(row, { site: 'peer' })).toBe(false);
    expect(matchesUsageQuery(row, { tokenId: 't2' })).toBe(false);
  });

  it('鍵で絞ると、帰属の無い行は外れる', () => {
    const unattributed = {
      date: row.date,
      managerId: row.managerId,
      layer: row.layer,
      site: row.site,
    };
    expect(matchesUsageQuery(unattributed, { tokenId: 't1' })).toBe(false);
    expect(matchesUsageQuery(unattributed, {})).toBe(true);
  });
});

describe('鍵', () => {
  it('区切りは NUL で、帰属の無い行は空の区画になる', () => {
    expect(usageRowKey('d', 'm', 'opus', 'manager', 'session', undefined)).toBe(
      'd\u0000m\u0000opus\u0000manager\u0000session\u0000',
    );
    expect(usageTurnKey('d', 'm', 'clone', 'peer', 't')).toBe(
      'd\u0000m\u0000clone\u0000peer\u0000t',
    );
    expect(usageUnmeteredKey('d', 'm', 'clone', 'peer', 'p', 't')).toBe(
      'd\u0000m\u0000clone\u0000peer\u0000p\u0000t',
    );
    expect(usageBaselineKey('clone', 'm')).toBe('clone\u0000m');
  });

  it('層・場所・帰属が違えば別の鍵になる（足し込まれて誤帰属にならない）', () => {
    const keys = new Set([
      usageRowKey('d', 'm', 'x', 'manager', 'session', undefined),
      usageRowKey('d', 'm', 'x', 'clone', 'session', undefined),
      usageRowKey('d', 'm', 'x', 'manager', 'peer', undefined),
      usageRowKey('d', 'm', 'x', 'manager', 'session', 't'),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe('並び', () => {
  const base = { date: 'd', managerId: 'm', layer: 'manager', site: 'session' } as const;
  const tokens = (rows: Array<{ tokenId?: string | undefined }>) => rows.map((r) => r.tokenId);

  it('帰属の無い行は最後で、U+FFFF の帰属はその前（番兵にしない）', () => {
    const turns: UsageTurnRow[] = [
      { ...base, turns: 1, updatedAt: 'x' },
      { ...base, tokenId: '￿', turns: 1, updatedAt: 'x' },
      { ...base, tokenId: 'b', turns: 1, updatedAt: 'x' },
      { ...base, tokenId: 'a', turns: 1, updatedAt: 'x' },
    ];
    expect(tokens([...turns].sort(compareUsageTurnRows))).toEqual(['a', 'b', '￿', undefined]);
    expect(tokens([...turns].reverse().sort(compareUsageTurnRows))).toEqual([
      'a',
      'b',
      '￿',
      undefined,
    ]);
  });

  it('日ごとの行はモデルが層・場所・帰属より先、測れなかった行は provider が帰属より先', () => {
    const totals = ZERO_USAGE;
    const dailies = [
      { ...base, model: 'opus', tokenId: 'a', totals, updatedAt: 'x' },
      { ...base, model: 'haiku', tokenId: 'z', totals, updatedAt: 'x' },
    ];
    expect([...dailies].sort(compareUsageRows).map((r) => r.model)).toEqual(['haiku', 'opus']);
    const unmetered = [
      { ...base, provider: 'b', tokenId: 'a', turns: 1, updatedAt: 'x' },
      { ...base, provider: 'a', turns: 1, updatedAt: 'x' },
    ];
    expect([...unmetered].sort(compareUsageUnmeteredRows).map((r) => r.provider)).toEqual([
      'a',
      'b',
    ]);
  });

  it('コード単位順で比べる（大文字が小文字より先）', () => {
    const rows = ['b', 'B', 'a'].map((managerId) => ({
      ...base,
      managerId,
      turns: 1,
      updatedAt: 'x',
    }));
    expect([...rows].sort(compareUsageTurnRows).map((r) => r.managerId)).toEqual(['B', 'a', 'b']);
  });
});

describe('addUsageTotals', () => {
  it('6つの量を足し、どちらにも unreadable が無ければ欄ごと作らない', () => {
    const a = {
      ...ZERO_USAGE,
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.5,
      webSearchRequests: 1,
    };
    const b = {
      ...ZERO_USAGE,
      inputTokens: 10,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    };
    const sum = addUsageTotals(a, b);
    expect(sum).toEqual({
      inputTokens: 11,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      webSearchRequests: 1,
      costUsd: 0.5,
    });
    expect('unreadable' in sum).toBe(false);
  });
});
