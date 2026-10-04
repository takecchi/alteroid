// @vitest-environment jsdom
/**
 * standalone（ホーム画面から開いた PWA）の safe-area の手当て（#2722）。
 *
 * `black-translucent` + `viewport-fit=cover` では、本文が状態バー・ノッチ・ホームバーの下まで
 * 描かれる。**jsdom はレイアウトを持たず `env()` を評価できない**ので、ここで固定できるのは
 * 「避けるクラスが書かれていること」まで（`page.test.tsx` と同じ形）。実機の見え方は測れていない。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppSidebar } from './layout/app-sidebar';
import { MobileTopBar } from './layout/mobile-top-bar';
import { ChatHeader } from './features/chat/chat-header';
import { Page } from './page';

afterEach(cleanup);

const classesOf = (el: Element | null) => (el?.className ?? '').toString().split(/\s+/);

describe('safe-area の手当て', () => {
  it('狭い画面の上端の帯は、上・左・右を避ける', () => {
    const { container } = render(<MobileTopBar status="live" onOpenNav={() => {}} />);
    expect(classesOf(container.querySelector('header'))).toEqual(
      expect.arrayContaining([
        'pt-[var(--safe-top)]',
        'pl-[var(--safe-left)]',
        'pr-[var(--safe-right)]',
      ]),
    );
  });

  it('広い画面の脇の面は、上・下・左を避ける。ドロワーの中では足さない（二重にしない）', () => {
    const items = [{ to: '/', label: 'ホーム', icon: () => null }];
    const render1 = (inDrawer: boolean) =>
      render(
        <AppSidebar
          status="live"
          items={items}
          renderLink={(_i, slot) => <a href="/">{slot.children}</a>}
          inDrawer={inDrawer}
        />,
      ).container.querySelector('nav, aside, div')!;
    const wide = classesOf(render1(false).closest('[class]'));
    cleanup();
    const drawer = classesOf(render1(true).closest('[class]'));
    for (const c of ['pt-[var(--safe-top)]', 'pb-[var(--safe-bottom)]', 'pl-[var(--safe-left)]']) {
      expect(wide).toContain(c);
      expect(drawer).not.toContain(c);
    }
  });

  it('広い画面（md 以上）のページの見出しは上を避ける（狭い画面は上端の帯が避ける）', () => {
    const { container } = render(<Page title="見出し">本文</Page>);
    expect(classesOf(container.querySelector('header'))).toContain(
      'md:pt-[calc(1rem+var(--safe-top))]',
    );
  });

  it('会話の見出しの帯も同じく上を避ける', () => {
    const { container } = render(<ChatHeader conversationId={undefined} />);
    expect(classesOf(container.querySelector('header'))).toContain(
      'md:pt-[calc(1rem+var(--safe-top))]',
    );
  });
});
