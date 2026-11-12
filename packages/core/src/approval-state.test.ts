import { describe, expect, it } from 'vitest';

import { approvalSettledAt, approvalStateOf, isApprovalFieldSet } from './approval-state.js';

// 承認の状態の判定を寄せた 1 つの関数（`approval-state.ts`）。core・logic・web・cli が使う。
const AT = '2026-10-29T00:00:00.000Z';

describe('approvalStateOf', () => {
  it('取り下げを先に見る: 両方立った行は withdrawn', () => {
    expect({
      neither: approvalStateOf({}),
      answered: approvalStateOf({ answeredAt: AT }),
      withdrawn: approvalStateOf({ withdrawnAt: AT }),
      both: approvalStateOf({ answeredAt: AT, withdrawnAt: AT }),
    }).toEqual({
      neither: 'unanswered',
      answered: 'answered',
      withdrawn: 'withdrawn',
      both: 'withdrawn',
    });
  });

  it('undefined と null は「立っていない」、空文字は「立っている」', () => {
    expect(isApprovalFieldSet(undefined)).toBe(false);
    expect(isApprovalFieldSet(null)).toBe(false);
    expect(isApprovalFieldSet('')).toBe(true);
    expect(approvalStateOf({ answeredAt: null, withdrawnAt: null })).toBe('unanswered');
    expect(approvalStateOf({ answeredAt: '' })).toBe('answered');
    expect(approvalStateOf({ withdrawnAt: '' })).toBe('withdrawn');
    expect(approvalStateOf({ answeredAt: AT, withdrawnAt: '' })).toBe('withdrawn');
  });
});

// 寄せる前に 4 か所（daemon・web・cli・core の approval-settled）が書いていた式。同じ結果を返すことを縛る。
type Fields = { answeredAt?: string | null | undefined; withdrawnAt?: string | null | undefined };
const originalExpressions = {
  daemonAndWeb: (a: Fields) => a.answeredAt ?? a.withdrawnAt ?? undefined,
  cli: (a: Fields) => a.answeredAt ?? a.withdrawnAt ?? '',
  coreSettled: (a: Fields) => a.answeredAt ?? a.withdrawnAt,
};

describe('approvalSettledAt', () => {
  const OTHER = '2026-10-30T00:00:00.000Z';

  it('回答のみ・取り下げのみ・両方（回答が先）・どちらも無し', () => {
    expect({
      answered: approvalSettledAt({ answeredAt: AT }),
      withdrawn: approvalSettledAt({ withdrawnAt: AT }),
      both: approvalSettledAt({ answeredAt: AT, withdrawnAt: OTHER }),
      neither: approvalSettledAt({}),
    }).toEqual({ answered: AT, withdrawn: AT, both: AT, neither: undefined });
  });

  it('null・空文字: null は立っていない、空文字は立っている（?? のまま）', () => {
    expect(approvalSettledAt({ answeredAt: null, withdrawnAt: null })).toBeUndefined();
    expect(approvalSettledAt({ answeredAt: null, withdrawnAt: OTHER })).toBe(OTHER);
    expect(approvalSettledAt({ answeredAt: undefined, withdrawnAt: OTHER })).toBe(OTHER);
    expect(approvalSettledAt({ answeredAt: '', withdrawnAt: OTHER })).toBe('');
    expect(approvalSettledAt({ answeredAt: null, withdrawnAt: '' })).toBe('');
  });

  it('元の 4 つの式と同じ結果を返す（戻りの扱いだけ呼び側で違う）', () => {
    const values: (string | null | undefined)[] = [undefined, null, '', AT, OTHER];
    for (const answeredAt of values) {
      for (const withdrawnAt of values) {
        const row = { answeredAt, withdrawnAt };
        const got = approvalSettledAt(row);
        expect(got).toBe(originalExpressions.daemonAndWeb(row));
        expect(got ?? '').toBe(originalExpressions.cli(row));
        expect(got ?? null).toBe(originalExpressions.coreSettled(row) ?? null);
      }
    }
  });
});
