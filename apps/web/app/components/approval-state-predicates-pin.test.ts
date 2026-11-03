import type { PendingApproval } from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

import {
  approvalStateOf,
  isApprovalAnswered,
  isApprovalWithdrawn,
} from './approval-answer-card.js';

// 承認の状態を見る判定の、いまの端の振る舞いを固定する（現状の挙動を固定。まとめる PR で見直す）。
// 本番コードは変えない。Web は `!== undefined && !== null` で見る。コア（`!== undefined`）は null を「立っている」と読み、
// CLI（真偽）は空文字も「立っていない」と読む。

const AT = '2026-10-06T10:03:00.000Z';
const base = { id: 'a', createdAt: AT, question: 'q' } as PendingApproval;
const make = (over: Record<string, unknown>): PendingApproval =>
  ({ ...base, ...over }) as PendingApproval;

describe('approval-answer-card.tsx の状態判定（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('組み合わせ: 両方立った行は withdrawn（取り下げが先）', () => {
    expect({
      neither: approvalStateOf(make({})),
      answered: approvalStateOf(make({ answeredAt: AT })),
      withdrawn: approvalStateOf(make({ withdrawnAt: AT })),
      both: approvalStateOf(make({ answeredAt: AT, withdrawnAt: AT })),
    }).toEqual({
      neither: 'unanswered',
      answered: 'answered',
      withdrawn: 'withdrawn',
      both: 'withdrawn',
    });
  });

  it('個別の判定は両方 true になりうる（優先は approvalStateOf だけが決める）', () => {
    const both = make({ answeredAt: AT, withdrawnAt: AT });
    expect(isApprovalAnswered(both)).toBe(true);
    expect(isApprovalWithdrawn(both)).toBe(true);
  });

  it('⚠ null は「立っていない」。空文字は「立っている」（CLI は空文字を立っていないと読む）', () => {
    expect(isApprovalAnswered(make({ answeredAt: null }))).toBe(false);
    expect(isApprovalWithdrawn(make({ withdrawnAt: null }))).toBe(false);
    expect(isApprovalAnswered(make({ answeredAt: '' }))).toBe(true);
    expect(isApprovalWithdrawn(make({ withdrawnAt: '' }))).toBe(true);
  });
});
