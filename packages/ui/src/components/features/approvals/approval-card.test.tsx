// @vitest-environment jsdom
/**
 * `ApprovalCard` の省略可能な口（`time` / `trailing`）と、その既定。
 *
 * 口は画面（`apps/web/app/routes/approvals.tsx`）が今の表示をそのまま出すために足した。
 * **口を渡さないときの振る舞いは変えていない**——既定の側もここで押さえる。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from './approval-card';

afterEach(cleanup);

const base = {
  state: 'unanswered' as const,
  createdAt: '2026-09-29T20:06:00Z',
  createdLabel: '42 分前',
  question: '進めてよいか',
};

describe('ApprovalCard: time', () => {
  it('既定: Timestamp（相対の表示を <time dateTime> で）を出す', () => {
    const { container } = render(<ApprovalCard {...base} />);
    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-09-29T20:06:00.000Z');
    expect(time?.textContent).toBe('42 分前');
  });

  it('time を渡すと、その位置に差し込み、Timestamp は出さない', () => {
    const { container } = render(
      <ApprovalCard
        {...base}
        time={
          <>
            <span>2026/09/29 20:06</span>
            <span>(42 分前)</span>
          </>
        }
      />,
    );
    expect(container.querySelector('time')).toBeNull();
    expect(screen.getByText('2026/09/29 20:06')).toBeTruthy();
    expect(screen.getByText('(42 分前)')).toBeTruthy();
  });

  it('time を渡すなら createdAt / createdLabel は要らない', () => {
    const { container } = render(<ApprovalCard state="unanswered" question="q" time="いま" />);
    expect(screen.getByText('いま')).toBeTruthy();
    expect(container.querySelector('time')).toBeNull();
  });
});

describe('ApprovalCard: 送るキー', () => {
  function typeAndPress(init: KeyboardEventInit & { isComposing?: boolean }, props = {}) {
    const onSubmit = vi.fn();
    render(<ApprovalCard {...base} draft="答え" onSubmit={onSubmit} {...props} />);
    fireEvent.keyDown(screen.getByRole('textbox'), init);
    return onSubmit;
  }

  it('既定: ⌘/Ctrl + Enter で送る', () => {
    expect(typeAndPress({ key: 'Enter', ctrlKey: true })).toHaveBeenCalledWith('答え');
    cleanup();
    expect(typeAndPress({ key: 'Enter', metaKey: true })).toHaveBeenCalledWith('答え');
  });

  it('既定: 修飾キー無しの Enter・IME の確定の Enter では送らない', () => {
    expect(typeAndPress({ key: 'Enter' })).not.toHaveBeenCalled();
    cleanup();
    expect(typeAndPress({ key: 'Enter', ctrlKey: true, isComposing: true })).not.toHaveBeenCalled();
  });

  it('空の回答・送信中は、ショートカットでも送らない（ボタンの disabled と同じ条件）', () => {
    expect(typeAndPress({ key: 'Enter', ctrlKey: true }, { draft: '  ' })).not.toHaveBeenCalled();
    cleanup();
    expect(typeAndPress({ key: 'Enter', ctrlKey: true }, { busy: true })).not.toHaveBeenCalled();
  });
});

describe('ApprovalCard: trailing と error の順序', () => {
  it('trailing は error の後ろ（いちばん下）に出る', () => {
    render(
      <ApprovalCard
        {...base}
        footer={<p>footer</p>}
        error={<p>error</p>}
        trailing={<p>trailing</p>}
      />,
    );
    const order = ['footer', 'error', 'trailing'].map((t) => screen.getByText(t));
    expect(
      order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('error を渡さなければ余白の箱を出さない', () => {
    const { container } = render(<ApprovalCard {...base} />);
    const empty = Array.from(container.querySelectorAll('div.mt-2')).filter(
      (box) => box.childElementCount === 0,
    );
    expect(empty).toHaveLength(0);
  });
});
