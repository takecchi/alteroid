// @vitest-environment jsdom
/**
 * `ListDetail` / `ListDetailItems`: 広い画面は一覧と詳細の2ペイン、狭い画面は
 * 未選択なら一覧・選択ありなら詳細＋ドロワー。一覧の中の矢印キー。
 *
 * 幅は `matchMedia` ではなくフックごと差し替える（`packages/ui` のテストは
 * `apps/web/app/test-support.tsx` を読めない。`markdown-editor.test.tsx` と同じ作法）。
 * 固定値ではなく、テストごとに切り替えられる値にしてある。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ListDetail, ListDetailItems } from './list-detail';

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../hooks/use-is-mobile', () => ({ useIsMobile: () => viewport.mobile }));

// jsdom には `scrollIntoView` が無い。呼ばれたことを見たいので、呼び出しを記録する関数を置く。
const scrollIntoView = vi.fn();
beforeEach(() => {
  viewport.mobile = false;
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

const ITEMS = ['a', 'b', 'c'].map((key) => ({ key, href: `#${key}`, label: `項目${key}` }));

function Demo({ initial }: { initial: string | undefined }) {
  const [selected, setSelected] = useState(initial);
  return (
    <ListDetail
      listLabel="日報"
      hasSelection={selected !== undefined}
      selectionKey={selected}
      emptyDetail={<p>日報を選んでください</p>}
      detail={<h2>詳細 {selected}</h2>}
      list={
        <ListDetailItems
          label="日報の一覧"
          items={ITEMS.map((item) => ({
            key: item.key,
            href: item.href,
            current: item.key === selected,
            children: item.label,
          }))}
          renderLink={(props) => (
            <a
              {...props}
              onClick={(event) => {
                event.preventDefault();
                setSelected(props.href.slice(1));
                props.onClick(event);
              }}
            >
              {props.children}
            </a>
          )}
        />
      }
    />
  );
}

describe('ListDetail: 広い画面', () => {
  it('一覧と詳細の両方が出て、選択中に aria-current="page" が付く', () => {
    render(<Demo initial="b" />);
    const nav = screen.getByRole('navigation', { name: '日報' });
    expect(screen.getByRole('heading', { level: 2, name: '日報' })).toBeTruthy();
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
    expect(within(nav).getByRole('link', { name: '項目b' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: '項目a' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(screen.getByRole('region', { name: '日報の詳細' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '詳細 b' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '日報を開く' })).toBeNull();
  });

  it('未選択なら右に案内を出す', () => {
    render(<Demo initial={undefined} />);
    expect(screen.getByText('日報を選んでください')).toBeTruthy();
  });

  it('↓/↑/Home/End で焦点だけが移り、選択は変わらない。端で止まる', () => {
    render(<Demo initial="a" />);
    const [a, b, c] = ['a', 'b', 'c'].map((k) => screen.getByRole('link', { name: `項目${k}` }));
    a?.focus();
    fireEvent.keyDown(a as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(a);
    expect(a?.getAttribute('aria-current')).toBe('page');
  });

  it('選択中の項目を初回に見える位置へ寄せる（焦点は移さない）', () => {
    render(<Demo initial="c" />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('link', { name: '項目c' }));
    expect(document.activeElement).toBe(document.body);
  });

  it('項目を選んでも焦点を詳細へ奪わない', () => {
    render(<Demo initial={undefined} />);
    const b = screen.getByRole('link', { name: '項目b' });
    b.focus();
    fireEvent.click(b);
    expect(document.activeElement).toBe(b);
  });
});

describe('ListDetail: 狭い画面', () => {
  beforeEach(() => {
    viewport.mobile = true;
  });

  it('未選択なら一覧を全幅で出し、詳細と開くボタンは出さない', () => {
    render(<Demo initial={undefined} />);
    expect(screen.getByRole('navigation', { name: '日報' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '日報を開く' })).toBeNull();
    expect(screen.queryByRole('region', { name: '日報の詳細' })).toBeNull();
  });

  it('選択ありなら詳細とボタン。ボタンで一覧がドロワーに出て、項目を押すと閉じて詳細へ焦点が移る', async () => {
    render(<Demo initial="a" />);
    expect(screen.queryByRole('navigation', { name: '日報' })).toBeNull();
    expect(screen.getByRole('heading', { name: '詳細 a' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '日報を開く' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('navigation', { name: '日報' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('link', { name: '項目c' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: '詳細 c' })).toBeTruthy();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('region', { name: '日報の詳細' })),
    );
  });
});
