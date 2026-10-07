// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AnsweredApprovalRow } from './answered-approval-row';

afterEach(cleanup);

const renderLink = ({ className, children }: { className: string; children: React.ReactNode }) => (
  <a href="/detail" className={className}>
    {children}
  </a>
);

describe('AnsweredApprovalRow', () => {
  it('行全体が1つのリンクで、札・時刻・問い・答えがその中にある', () => {
    render(
      <AnsweredApprovalRow
        state="answered"
        time="09/30 14:05"
        question="進めてよいか"
        answer="進める"
        renderLink={renderLink}
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/detail');
    for (const text of ['回答済', '09/30 14:05', '進めてよいか', '進める']) {
      expect(within(link).getByText(text), text).toBeTruthy();
    }
  });

  it('取り下げ済は別の札で、理由を出す。答えの欄は出さない', () => {
    render(
      <AnsweredApprovalRow
        state="withdrawn"
        time="09/30 14:05"
        question="進めてよいか"
        answer="出ない"
        withdrawnReason="自分で見つけた"
        renderLink={renderLink}
      />,
    );
    const link = screen.getByRole('link');
    expect(within(link).getByText('取り下げ済')).toBeTruthy();
    expect(within(link).queryByText('回答済')).toBeNull();
    expect(within(link).getByText('自分で見つけた')).toBeTruthy();
    expect(link.textContent).not.toContain('出ない');
  });

  it('答え・理由が無ければ、その欄を出さない（「無い」と言い切る文を足さない）', () => {
    const { rerender } = render(
      <AnsweredApprovalRow state="answered" time="t" question="q" renderLink={renderLink} />,
    );
    expect(screen.getByRole('link').textContent).not.toContain('答え');
    rerender(
      <AnsweredApprovalRow state="withdrawn" time="t" question="q" renderLink={renderLink} />,
    );
    expect(screen.getByRole('link').textContent).not.toContain('理由');
  });

  it('本文は2行で切る（line-clamp）。全文は詳細で読む', () => {
    render(
      <AnsweredApprovalRow
        state="answered"
        time="t"
        question="長い問い"
        answer="長い答え"
        renderLink={renderLink}
      />,
    );
    expect(screen.getByText('長い問い').className).toContain('line-clamp-2');
    expect(screen.getByText('長い答え').className).toContain('line-clamp-2');
  });
});
