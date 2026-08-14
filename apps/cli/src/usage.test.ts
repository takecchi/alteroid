import {
  USAGE_ESTIMATE_NOTICE,
  ZERO_USAGE,
  type UsageAggregate,
  type UsageRow,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { renderUsage } from './usage.js';

function row(over: Partial<UsageRow> & { managerId: string; costUsd: number }): UsageRow {
  const { costUsd, ...rest } = over;
  return {
    date: '2026-08-14',
    model: 'claude-opus-4',
    updatedAt: '2026-08-14T10:00:00.000Z',
    ...rest,
    totals: { ...ZERO_USAGE, costUsd },
  };
}

function aggregate(over: Partial<UsageAggregate>): UsageAggregate {
  return {
    rows: [],
    since: '2026-08-01T00:00:00.000Z',
    beforeLedger: false,
    notice: USAGE_ESTIMATE_NOTICE,
    ...over,
  };
}

describe('renderUsage', () => {
  it('台帳がまだ空（since が null）なら $0.00 とは言わず、記録が無いと言う', () => {
    const text = renderUsage(aggregate({ rows: [], since: null }));

    expect(text).not.toContain('$0.00');
    expect(text).toContain('まだ1件も記録が無い');
    // まだ何も出せていなくても但し書きは必ず添える。
    expect(text).toContain(USAGE_ESTIMATE_NOTICE);
  });

  it('beforeLedger が真なら 0 と言わず、記録が無い範囲だと明示する', () => {
    const text = renderUsage(
      aggregate({
        rows: [row({ managerId: 'm1', costUsd: 0.5 })],
        beforeLedger: true,
      }),
    );

    expect(text).toContain('記録が無い');
    expect(text).not.toMatch(/合計\s*\$0\.00/);
  });

  it('$1 未満を $0.00 に丸めない（formatUsd をそのまま使う）', () => {
    const text = renderUsage(aggregate({ rows: [row({ managerId: 'm1', costUsd: 0.0123 })] }));

    expect(text).toContain('$0.0123');
    expect(text).not.toContain('$0.00');
  });

  it('但し書きを必ず出す', () => {
    const text = renderUsage(aggregate({ rows: [row({ managerId: 'm1', costUsd: 1.2 })] }));

    expect(text).toContain(USAGE_ESTIMATE_NOTICE);
  });

  it('軸の上限を超えたら、打ち切ったことを書く（黙って切り捨てない）', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ managerId: `m${String(i).padStart(2, '0')}`, costUsd: 1 }),
    );
    const text = renderUsage(aggregate({ rows }));

    expect(text).toContain('残り 5 件は出していない');
  });

  it('日別・マネージャー別・モデル別の内訳をすべて出す', () => {
    const rows = [
      row({ managerId: 'm1', model: 'opus', date: '2026-08-13', costUsd: 1 }),
      row({ managerId: 'm2', model: 'sonnet', date: '2026-08-14', costUsd: 2 }),
    ];
    const text = renderUsage(aggregate({ rows }));

    expect(text).toContain('日別:');
    expect(text).toContain('マネージャー別:');
    expect(text).toContain('モデル別:');
    expect(text).toContain('合計 $3.00');
  });
});
