// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const visual = link.querySelector('[aria-hidden="true"]:not(svg)');
    expect(visual?.textContent).toBe('3');
    expect(visual?.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('来週の資料').className).toContain('font-semibold');
  });

  it.each([[0], [undefined]])('未読が %s なら印を出さず、行の文字も強くしない', (unread) => {
    renderList(unread);

    expect(screen.queryByText(/未読/)).toBeNull();
    expect(screen.getByText('来週の資料').className).not.toContain('font-semibold');
  });
});

describe('ConversationList: 発言数', () => {
  function subline(messagesAtLeast: boolean | undefined): string {
    render(
      <ConversationList
        items={[
          {
            id: 'c1',
            preview: '来週の資料',
            updatedLabel: '3 分前',
            messages: 4,
            ...(messagesAtLeast === undefined ? {} : { messagesAtLeast }),
          },
        ]}
        activeId={undefined}
        renderLink={(_target, slot) => <a className={slot.className}>{slot.children}</a>}
      />,
    );
    return screen.getByText(/3 分前/).textContent ?? '';
  }

  it('「発言 N 件」と出す（往復とは言わない）', () => {
    expect(subline(undefined)).toBe('3 分前 · 発言 4 件');
  });

  it('messagesAtLeast が偽なら「以上」を付けない', () => {
    expect(subline(false)).toBe('3 分前 · 発言 4 件');
  });

  it('messagesAtLeast が真なら「発言 N 件以上」', () => {
    expect(subline(true)).toBe('3 分前 · 発言 4 件以上');
  });
});

describe('ConversationList: もっと見る（#3404）', () => {
  const renderLink = (_target: unknown, slot: { className: string; children: React.ReactNode }) => (
    <a href="#x" className={slot.className}>
      {slot.children}
    </a>
  );
  const items = [{ id: 'c1', preview: 'a', updatedLabel: '1 分前', messages: 1 }];

  it('more が無ければボタンを出さない', () => {
    render(<ConversationList items={items} activeId={undefined} renderLink={renderLink} />);
    expect(screen.queryByRole('button', { name: 'もっと見る' })).toBeNull();
  });

  it('more があれば押せて、読み込み中は押せない', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <ConversationList
        items={items}
        activeId={undefined}
        renderLink={renderLink}
        more={{ onClick }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'もっと見る' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <ConversationList
        items={items}
        activeId={undefined}
        renderLink={renderLink}
        more={{ onClick, loading: true }}
      />,
    );
    expect(
      (screen.getByRole('button', { name: '読み込み中…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('続きの失敗は一覧の下に小さく出て、一覧は残る', () => {
    render(
      <ConversationList
        items={items}
        activeId={undefined}
        renderLink={renderLink}
        more={{ onClick: () => {}, error: new Error('繋がらない') }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('続きを読めなかった（繋がらない）');
    expect(screen.getByRole('link', { name: /a/ })).toBeTruthy();
  });
});
