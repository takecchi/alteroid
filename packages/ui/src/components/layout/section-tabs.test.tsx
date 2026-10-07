// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TAB_TRIGGER_CLASS } from '../common';

import { SectionTabs } from './section-tabs';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SectionTabs', () => {
  it('タブごとに renderLink を呼び、現在地のタブにだけ isActive を渡す', () => {
    render(
      <SectionTabs
        label="仕事のページ"
        tabs={[
          { to: '/a', label: 'A' },
          { to: '/b', label: 'B' },
        ]}
        renderLink={(tab, slot) => (
          <a
            href={tab.to}
            aria-current={tab.to === '/b' ? 'page' : undefined}
            className={slot.className(tab.to === '/b')}
          >
            {slot.children}
          </a>
        )}
      />,
    );
    const nav = screen.getByRole('navigation', { name: '仕事のページ' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['A', 'B']);
    expect(links[0]?.className).not.toContain('border-primary');
    expect(links[1]?.className).toContain('border-primary');
    expect(links[1]?.getAttribute('aria-current')).toBe('page');
    expect(links[0]?.getAttribute('aria-current')).toBeNull();
  });

  it('タブの高さは、タッチ（pointer: coarse）で 44px 級へ広がる寸法のクラスを持つ', () => {
    expect(TAB_TRIGGER_CLASS).toContain('py-1.5');
    expect(TAB_TRIGGER_CLASS).toContain('pointer-coarse:py-3');
  });
});

const TABS = Array.from({ length: 8 }, (_, i) => ({ to: `/t${i}`, label: `タブ${i}` }));
const TAB_WIDTH = 100;
const VIEW_WIDTH = 300;

function installLayout() {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.tagName === 'UL' ? VIEW_WIDTH : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.tagName === 'UL' ? TABS.length * TAB_WIDTH : 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.tagName === 'UL') return new DOMRect(0, 0, VIEW_WIDTH, 40);
    const list = this.closest('ul');
    const index = Number(this.getAttribute('data-index'));
    if (!list || Number.isNaN(index)) return new DOMRect();
    return new DOMRect(index * TAB_WIDTH - list.scrollLeft, 0, TAB_WIDTH, 40);
  });
}

function renderTabs(active: number) {
  return render(
    <SectionTabs
      label="設定のページ"
      tabs={TABS}
      renderLink={(tab, slot) => {
        const index = TABS.findIndex((t) => t.to === tab.to);
        return (
          <a
            href={tab.to}
            data-index={index}
            aria-current={index === active ? 'page' : undefined}
            className={slot.className(index === active)}
          >
            {slot.children}
          </a>
        );
      }}
    />,
  );
}

describe('SectionTabs: 選んでいるタブへ寄せる', () => {
  beforeEach(installLayout);

  it('選んでいるタブが帯の外（右）にあれば、見える範囲へ入るまで scrollLeft を動かす', () => {
    renderTabs(7);
    const list = screen.getByRole('list') as HTMLElement;
    const left = 7 * TAB_WIDTH - list.scrollLeft;
    expect(list.scrollLeft).toBeGreaterThan(0);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + TAB_WIDTH).toBeLessThanOrEqual(VIEW_WIDTH);
    expect(list.scrollLeft).toBeLessThanOrEqual(500);
  });

  it('すでに見える位置のタブなら動かさない', () => {
    renderTabs(0);
    expect((screen.getByRole('list') as HTMLElement).scrollLeft).toBe(0);
  });

  it('選択中の印が付け替わったら、新しい選択中のタブへ寄せ直す', async () => {
    renderTabs(0);
    const list = screen.getByRole('list') as HTMLElement;
    const links = within(list).getAllByRole('link');
    await act(async () => {
      links[0]?.removeAttribute('aria-current');
      links[6]?.setAttribute('aria-current', 'page');
      await Promise.resolve();
    });
    expect(list.scrollLeft).toBeGreaterThan(0);
    expect(6 * TAB_WIDTH - list.scrollLeft + TAB_WIDTH).toBeLessThanOrEqual(VIEW_WIDTH);
  });
});

describe('SectionTabs: 続きがあると分かる端の表示', () => {
  beforeEach(installLayout);

  const edge = (name: 'start' | 'end') => document.querySelector(`[data-edge="${name}"]`);

  it('先頭のタブを選んでいれば、右の端だけに出す', () => {
    renderTabs(0);
    expect(edge('end')).not.toBeNull();
    expect(edge('start')).toBeNull();
  });

  it('末尾のタブを選んでいれば、左の端だけに出す', () => {
    renderTabs(7);
    expect(edge('start')).not.toBeNull();
    expect(edge('end')).toBeNull();
  });

  it('スクロールすると出し分けが変わる（中ほどでは両端に出る）', () => {
    renderTabs(0);
    const list = screen.getByRole('list') as HTMLElement;
    act(() => {
      list.scrollLeft = 200;
      fireEvent.scroll(list);
    });
    expect(edge('start')).not.toBeNull();
    expect(edge('end')).not.toBeNull();
  });

  it('端の表示は読み上げず、押せない（aria-hidden・pointer-events-none）', () => {
    renderTabs(0);
    const el = edge('end');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.className).toContain('pointer-events-none');
  });

  it('全部が収まっているときは出さない', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.tagName === 'UL' ? VIEW_WIDTH : 0;
    });
    renderTabs(0);
    expect(edge('start')).toBeNull();
    expect(edge('end')).toBeNull();
  });
});
