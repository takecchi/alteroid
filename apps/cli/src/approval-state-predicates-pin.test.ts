import { describe, expect, it } from 'vitest';

import { approvalText, type ConversationApproval } from './conversation-approvals.js';

// 承認の状態（未回答・回答済・取り下げ）を見る判定の、いまの端の振る舞いを固定する（現状の挙動を固定。まとめる PR で見直す）。
// 本番コードは変えない。CLI の `approvalText` は `withdrawnAt` / `answeredAt` を真偽（truthy）で見る。
// コア（`!== undefined`）・Web（`!== undefined && !== null`）と、空文字・null の扱いが違う。

const AT = '2026-10-06T10:03:00.000Z';
const base: ConversationApproval = {
  id: 'abcdef12-3456-7890',
  createdAt: '2026-10-06T10:01:00.000Z',
  question: 'q',
};

const stateOf = (over: Partial<ConversationApproval>): string => {
  const line = approvalText({ ...base, ...over });
  if (line.includes('→ 取り下げ')) return 'withdrawn';
  if (line.includes('→ 回答済み')) return 'answered';
  if (line.includes('→ 未回答')) return 'unanswered';
  return 'unknown';
};

describe('conversation-approvals.ts approvalText の状態（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('組み合わせ: 未回答 / 回答済 / 取り下げ / 両方立った行は取り下げ（取り下げが先）', () => {
    expect({
      neither: stateOf({}),
      answered: stateOf({ answeredAt: AT }),
      withdrawn: stateOf({ withdrawnAt: AT }),
      both: stateOf({ answeredAt: AT, withdrawnAt: AT }),
    }).toEqual({
      neither: 'unanswered',
      answered: 'answered',
      withdrawn: 'withdrawn',
      both: 'withdrawn',
    });
  });

  it('空文字は「立っている」、null は「立っていない」と読む（core の `approvalStateOf` に寄せた）', () => {
    // 反転済み（まとめる PR）: #6298 時点の期待は「⚠ 空文字・null は『立っていない』と読む（真偽で見る）」で、空文字の 3 つが
    // emptyAnswered: unanswered / emptyWithdrawn: unanswered / emptyWithdrawnWithAnswer: answered だった。
    // 経緯: core・logic・web は空文字を「立っている」と読む多数派。cli だけ真偽で見ていたのをそろえた。null は web と cli がもともと「立っていない」で、型の上で null が来ない core・logic に影響しないので、答えが変わらない側（立っていない）を選んだ。
    expect({
      emptyAnswered: stateOf({ answeredAt: '' }),
      nullAnswered: stateOf({ answeredAt: null }),
      emptyWithdrawn: stateOf({ withdrawnAt: '' }),
      nullWithdrawn: stateOf({ withdrawnAt: null }),
      emptyWithdrawnWithAnswer: stateOf({ answeredAt: AT, withdrawnAt: '' }),
    }).toEqual({
      emptyAnswered: 'answered',
      nullAnswered: 'unanswered',
      emptyWithdrawn: 'withdrawn',
      nullWithdrawn: 'unanswered',
      emptyWithdrawnWithAnswer: 'withdrawn',
    });
  });
});
