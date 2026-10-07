// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { Activity } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppSidebar, type AppSidebarItem } from './app-sidebar';

afterEach(cleanup);

function renderSidebar(items: AppSidebarItem[]) {
  return render(
    <AppSidebar
      status="live"
      items={items}
      renderLink={(item, slot) => (
        <a href={item.to} className={slot.className(false)}>
          {slot.children}
        </a>
      )}
    />,
  );
}

describe('AppSidebar のまとまり', () => {
  it('section が変わったところにだけ見出しを出し、同じ section の2行目には出さない', () => {
    renderSidebar([
      { to: '/', label: 'ホーム', icon: Activity },
      { to: '/a', label: 'A', icon: Activity, section: '仕事' },
      { to: '/b', label: 'B', icon: Activity, section: '仕事' },
      { to: '/c', label: 'C', icon: Activity, section: '記録' },
    ]);
    expect(screen.getAllByText('仕事')).toHaveLength(1);
    expect(screen.getAllByText('記録')).toHaveLength(1);
    const items = screen.getAllByRole('listitem');
    expect(items[1]?.textContent).toBe('仕事A');
    expect(items[2]?.textContent).toBe('B');
    expect(items[3]?.textContent).toBe('記録C');
  });

  it('空文字の section は見出しを出さず、区切り線だけ引く', () => {
    renderSidebar([
      { to: '/', label: 'ホーム', icon: Activity },
      { to: '/settings', label: '設定', icon: Activity, section: '' },
    ]);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    expect(screen.getAllByRole('listitem')[1]?.textContent).toBe('設定');
  });

  it('section を1つも使わなければ、見出しも区切り線も出ない（これまでと同じ見た目）', () => {
    renderSidebar([
      { to: '/', label: 'ホーム', icon: Activity },
      { to: '/chat', label: '会話', icon: Activity },
    ]);
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ホーム', '会話']);
  });
});
