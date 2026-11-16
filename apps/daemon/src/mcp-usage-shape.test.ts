import { summarizeUsage } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { USAGE_SECTIONS, shapeUsageAggregate, usageAttempts } from './mcp-usage-shape.js';

describe('usage_read の sections は実在する欄の名前だけ', () => {
  it('totals 以外の名前は、集計の内訳か集計の欄として実在する', () => {
    const breakdown = summarizeUsage([], []);
    const { data } = shapeUsageAggregate(
      {
        breakdown,
        unrecordedManagers: [],
        unreadableRows: [],
        unmeteredRows: [],
        resets: [],
      },
      { top: 1 },
    );
    const real = new Set([...Object.keys(data.breakdown as object), ...Object.keys(data)]);
    for (const name of USAGE_SECTIONS) {
      if (name === 'totals') expect(real.has('total')).toBe(true);
      else expect(real.has(name)).toBe(true);
    }
  });
});

describe('縮める段の並び', () => {
  it('要求 → top を減らす → 合計だけ。要求が小さければそれ以上の top は試さない', () => {
    expect(usageAttempts({}).map((a) => a.step)).toEqual([
      'requested',
      'top=50',
      'top=20',
      'top=10',
      'top=5',
      'totals-only',
    ]);
    expect(usageAttempts({ top: 20 }).map((a) => a.step)).toEqual([
      'requested',
      'top=10',
      'top=5',
      'totals-only',
    ]);
  });
});
