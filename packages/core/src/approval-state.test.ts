import { describe, expect, it } from 'vitest';

import { approvalStateOf, isApprovalFieldSet } from './approval-state.js';

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
