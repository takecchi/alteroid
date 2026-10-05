// @vitest-environment jsdom
/**
 * やり方の一覧と中身は1画面（`ListDetail`）。親の経路（`practices.tsx`）が左に一覧を持ち、
 * 子の経路（`practice-detail.tsx`）が右に出る。**jsdom はレイアウトを持たないので、押さえられるのは
 * 構造・リンク・属性・未保存の確認まで**（寸法とスクロールは実ブラウザで見た）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice } from '@alteroid/logic';
import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import PracticeDetail, { clientLoader } from './practice-detail';
import type { Route } from './+types/practice-detail';
import Practices from './practices';

function make(slug: string, title: string, content: string): Practice {
  return {
    slug,
    kind: 'procedure',
    title,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    chars: content.length,
    content,
  };
}
const A = make('alpha', 'アルファの手順', '# アルファの本文');
const B = make('beta', 'ベータの手順', '# ベータの本文');
const ALL = [A, B];

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
  globalThis.fetch = originalFetch;
});

function DetailRoute() {
  const { slug } = useParams();
  const loaderData = clientLoader({ params: { slug } } as Route.ClientLoaderArgs);
  return <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />;
}

/** 本番と同じ入れ子（`routes.ts`）。 */
function renderAt(url: string) {
  stubFetch((u) => {
    if (/\/practices\/[^/?]+\/versions/.test(u)) return json({ versions: [] });
    const one = /\/practices\/(alpha|beta)(\?|$)/.exec(u);
    if (one !== null) {
      const found = ALL.find((d) => d.slug === one[1]);
      return found === undefined ? undefined : json({ practice: found });
    }
    if (u.includes('/practices')) {
      return json({ practices: ALL.map((d) => ({ ...d, content: undefined })) });
    }
    return undefined;
  });
  const router = createMemoryRouter(
    [
      {
        path: '/practices',
        Component: Practices,
        children: [{ path: ':slug', Component: DetailRoute }],
      },
      { path: '/memory', Component: () => null },
    ],
    { initialEntries: [url] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

function current(nav: HTMLElement) {
  return within(nav)
    .getAllByRole('link')
    .filter((l) => l.getAttribute('aria-current') === 'page')
    .map((l) => l.getAttribute('href'));
}

describe('やり方の一覧＋詳細', () => {
  it('/practices/:slug を直接開くと、左に一覧・右に中身が出て、選択中の行が現在地になる', async () => {
    renderAt('/practices/beta');

    const nav = await screen.findByRole('navigation', { name: 'やり方の一覧' });
    expect(nav.className.split(/\s+/)).toContain('overflow-y-auto');
    expect(await within(nav).findAllByRole('link')).toHaveLength(2);
    expect(current(nav)).toEqual(['/practices/beta']);

    const detail = screen.getByRole('region', { name: 'やり方の中身' });
    expect(
      await within(detail).findByRole('heading', { level: 1, name: 'ベータの本文' }),
    ).toBeTruthy();
    expect(within(detail).getByRole('heading', { level: 2, name: 'beta' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '削除' })).toBeTruthy();
    // 版の一覧のタブも中身の中に残る。
    expect(within(detail).getByRole('tab', { name: '履歴' })).toBeTruthy();
    expect(detail.textContent).not.toContain('undefined');
    expect(screen.queryByRole('button', { name: 'やり方の一覧を開く' })).toBeNull();
    expect(screen.getByLabelText(/^名前/)).toBeTruthy();
  });

  it('/practices（未選択）では右に案内が出て、現在地の行は無い', async () => {
    renderAt('/practices');

    await screen.findByText('アルファの手順');
    const detail = screen.getByRole('region', { name: 'やり方の中身' });
    expect(within(detail).getByText(/左の一覧からやり方を選ぶ/)).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'やり方の一覧' }))
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  it('名前を入れて Enter で、そのやり方の画面へ移る', async () => {
    const router = renderAt('/practices');

    const input = await screen.findByLabelText(/^名前/);
    fireEvent.change(input, { target: { value: 'new-one' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(router.state.location.pathname).toBe('/practices/new-one'));
  });

  it('一覧の行を押すと右の中身が切り替わる', async () => {
    const router = renderAt('/practices/alpha');

    const nav = await screen.findByRole('navigation', { name: 'やり方の一覧' });
    const links = await within(nav).findAllByRole('link');
    fireEvent.click(links[1] as HTMLElement);

    await waitFor(() => expect(router.state.location.pathname).toBe('/practices/beta'));
    expect(await screen.findByRole('heading', { level: 1, name: 'ベータの本文' })).toBeTruthy();
    await waitFor(() => expect(current(nav)).toEqual(['/practices/beta']));
  });

  describe('未保存の編集', () => {
    async function startEditing() {
      const detail = await screen.findByRole('region', { name: 'やり方の中身' });
      fireEvent.mouseDown(await within(detail).findByRole('tab', { name: '編集' }));
      fireEvent.change(await within(detail).findByLabelText('題'), {
        target: { value: '書きかけ' },
      });
    }
    const titleInput = () =>
      within(screen.getByRole('region', { name: 'やり方の中身' })).getByLabelText(
        '題',
      ) as HTMLInputElement;

    it('左の一覧で別の項目を押すと確認が出る。やめれば留まり、下書きも残る', async () => {
      const router = renderAt('/practices/alpha');
      await startEditing();

      const nav = screen.getByRole('navigation', { name: 'やり方の一覧' });
      fireEvent.click(within(nav).getByRole('link', { name: /ベータの手順/ }));

      expect(await screen.findByRole('alertdialog')).toBeTruthy();
      expect(router.state.location.pathname).toBe('/practices/alpha');
      fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(router.state.location.pathname).toBe('/practices/alpha');
      expect(titleInput().value).toBe('書きかけ');
    });

    it('「破棄して離れる」で移り、移った先に前の下書きは持ち越されない', async () => {
      const router = renderAt('/practices/alpha');
      await startEditing();

      const nav = screen.getByRole('navigation', { name: 'やり方の一覧' });
      fireEvent.click(within(nav).getByRole('link', { name: /ベータの手順/ }));
      fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));

      await waitFor(() => expect(router.state.location.pathname).toBe('/practices/beta'));
      expect(await screen.findByRole('heading', { level: 1, name: 'ベータの本文' })).toBeTruthy();
      expect(screen.queryByDisplayValue('書きかけ')).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('変更が無ければ確認なしで移る', async () => {
      const router = renderAt('/practices/alpha');
      await screen.findByRole('heading', { level: 1, name: 'アルファの本文' });

      const nav = screen.getByRole('navigation', { name: 'やり方の一覧' });
      fireEvent.click(within(nav).getByRole('link', { name: /ベータの手順/ }));

      await waitFor(() => expect(router.state.location.pathname).toBe('/practices/beta'));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  describe('スマホ幅', () => {
    it('中身が全幅で出て、「やり方の一覧を開く」でドロワーに一覧が出る', async () => {
      setViewportWidth(390);
      renderAt('/practices/alpha');

      expect(await screen.findByRole('button', { name: '削除' })).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'やり方の一覧' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'やり方の一覧を開く' }));
      const nav = await screen.findByRole('navigation', { name: 'やり方の一覧' });
      expect(await within(nav).findAllByRole('link')).toHaveLength(2);
      expect(current(nav)).toEqual(['/practices/alpha']);
    });

    it('/practices では一覧が全幅で出る（中身の領域もボタンも無い）', async () => {
      setViewportWidth(390);
      renderAt('/practices');

      expect(await screen.findByText('アルファの手順')).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'やり方の中身' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'やり方の一覧を開く' })).toBeNull();
    });
  });
});
