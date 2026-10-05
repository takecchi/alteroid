// @vitest-environment jsdom
/**
 * 会話の一覧の未読の印。通知の記号と件数で出し（色だけに頼らない）、読み上げには
 * 「未読 N 件」を1回だけ言う。0 件・省略なら印を出さない。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationList } from './conversation-list';

afterEach(cleanup);

function renderList(unread: number | undefined) {
  render(
    <ConversationList
      items={[
        {
          id: 'c1',
          preview: '来週の資料',
          updatedLabel: '3 分前',
          messages: 4,
          ...(unread === undefined ? {} : { unread }),
        },
      ]}
      activeId={undefined}
      renderLink={(_target, slot) => (
        <a href="#x" className={slot.className}>
          {slot.children}
        </a>
      )}
    />,
  );
}

describe('ConversationList: 未読の印', () => {
  it('未読があれば、項目の名前に「未読 N 件」が1回だけ入り、数字と記号は読み上げから外れる', () => {
    renderList(3);

    const link = screen.getByRole('link', { name: /来週の資料/ });
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(link.textContent).toContain('未読 3 件');
    // 視覚用の件数（記号つき）は aria-hidden の中。
    const visual = link.querySelector('[aria-hidden="true"]:not(svg)');
    expect(visual?.textContent).toBe('3');
    expect(visual?.querySelector('svg')).not.toBeNull();
    // 行の文字が少し強くなる（色だけに頼らない）。
    expect(screen.getByText('来週の資料').className).toContain('font-semibold');
  });

  it.each([[0], [undefined]])('未読が %s なら印を出さず、行の文字も強くしない', (unread) => {
    renderList(unread);

    expect(screen.queryByText(/未読/)).toBeNull();
    expect(screen.getByText('来週の資料').className).not.toContain('font-semibold');
  });
});
