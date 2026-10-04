// @vitest-environment jsdom
/**
 * `SectionTabs`: 行き先の数だけリンクを描き、いま居る画面だけを `isActive` で示す。
 * ナビゲーションの名前（読み上げ）が付く。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SectionTabs } from './section-tabs';

afterEach(cleanup);

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
});
