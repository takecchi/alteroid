import { describe, expect, it } from 'vitest';

import {
  approvalLine,
  approvalNoticeLines,
  interleaveApprovals,
  type ConversationApproval,
} from './conversation-approvals.js';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const approval = (over: Partial<ConversationApproval> = {}): ConversationApproval => ({
  id: 'abcdef12-3456-7890',
  createdAt: '2026-10-06T10:01:00.000Z',
  question: 'どちらで進めますか？',
  ...over,
});

describe('approvalLine（承認1件の1行）', () => {
  it('未回答は「未回答」で終わり、id は先頭8字だけ', () => {
    expect(approvalLine(approval())).toBe(
      '? [2026-10-06T10:01:00.000Z] 確認（承認待ち abcdef12）: どちらで進めますか？ → 未回答',
    );
  });

  it('回答済みは回答の時刻と回答を出す', () => {
    const line = approvalLine(
      approval({ answeredAt: '2026-10-06T10:03:00.000Z', answer: 'A案で' }),
    );
    expect(line).toContain('→ 回答済み（2026-10-06T10:03:00.000Z）: A案で');
  });

  it('取り下げは理由を出し、回答済みと両方立っていたら取り下げを優先する', () => {
    const line = approvalLine(
      approval({
        answeredAt: '2026-10-06T10:03:00.000Z',
        answer: 'x',
        withdrawnAt: '2026-10-06T10:04:00.000Z',
        withdrawnReason: '自分で解決した',
      }),
    );
    expect(line).toContain('→ 取り下げ（2026-10-06T10:04:00.000Z）: 自分で解決した');
    expect(line).not.toContain('回答済み');
  });

  it('設問つきの承認は設問の要約を添え、改行は1行へ畳む', () => {
    const line = approvalLine(
      approval({
        question: '1行目\n2行目',
        questions: [
          {
            id: 'q1',
            prompt: 'p',
            multiple: true,
            options: [{ id: 'o', label: 'l' }],
          },
        ],
      }),
    );
    expect(line).not.toContain('\n');
    expect(line).toContain('1行目 2行目（設問 1 件（うち複数選択 1）（選択肢つき））');
  });

  it('質問・回答・理由は伏せ字を通す', () => {
    const line = approvalLine(
      approval({
        question: `鍵 ${TOKEN} を使う？`,
        answeredAt: '2026-10-06T10:03:00.000Z',
        answer: `使う ${TOKEN}`,
      }),
    );
    expect(line).not.toContain('ghp_a1B2c3D4e5');
  });
});

describe('interleaveApprovals（時刻順）', () => {
  const messages = [
    { id: 'm1', at: '2026-10-06T10:00:00.000Z' },
    { id: 'm2', at: '2026-10-06T10:05:00.000Z' },
  ];

  it('承認は createdAt の位置に入り、回答のあとの返信は承認の後ろに来る', () => {
    const items = interleaveApprovals(messages, [
      approval({ answeredAt: '2026-10-06T10:03:00.000Z', answer: 'A' }),
    ]);
    expect(items.map((i) => (i.kind === 'message' ? i.message.id : 'approval'))).toEqual([
      'm1',
      'approval',
      'm2',
    ]);
  });

  it('すべての発言より後の承認は末尾、前の承認は先頭に置く', () => {
    const items = interleaveApprovals(messages, [
      approval({ id: 'late', createdAt: '2026-10-06T11:00:00.000Z' }),
      approval({ id: 'early', createdAt: '2026-10-06T09:00:00.000Z' }),
    ]);
    expect(items.map((i) => (i.kind === 'message' ? i.message.id : i.approval.id))).toEqual([
      'early',
      'm1',
      'm2',
      'late',
    ]);
  });
});

describe('approvalNoticeLines', () => {
  it('取れたなら断りは無い', () => {
    expect(approvalNoticeLines({ approvals: [], unreadable: [] })).toEqual([]);
  });

  it('取れなかったことと、承認が無かったのではないことを言う', () => {
    const [line] = approvalNoticeLines({ approvals: [], unreadable: [], failure: 'HTTP 500' });
    expect(line).toContain('取れませんでした: HTTP 500');
    expect(line).toContain('承認が無かったのではありません');
  });

  it('読めない行は件数と id を言う', () => {
    const [line] = approvalNoticeLines({
      approvals: [],
      unreadable: [{ id: 'bad-1', reason: 'x' }, { reason: 'y' }],
    });
    expect(line).toContain('2 件');
    expect(line).toContain('bad-1');
  });
});
