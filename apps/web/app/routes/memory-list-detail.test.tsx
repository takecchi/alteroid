// @vitest-environment jsdom
/**
 * 記憶の一覧と中身は1画面（`ListDetail`）。親の経路（`memory.tsx`）が左に一覧を持ち、
 * 子の経路（`memory-detail.tsx`）が右に出る。**jsdom はレイアウトを持たないので、押さえられるのは
 * 構造・リンク・属性・未保存の確認まで**（寸法とスクロールは実ブラウザで見た）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '@alteroid/logic';
import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import MemoryDetail, { clientLoader } from './memory-detail';
import type { Route } from './+types/memory-detail';
import Memory from './memory';

function make(slug: string, title: string, content: string): MemoryDocument {
  return {
    slug,
    title,
    updatedAt: '2026-08-22T00:00:00.000Z',
    createdAt: { kind: 'unknown' },
    bytes: 42,
    frontmatter: { kind: 'none' },
    kind: 'fact',
    descriptionFreshness: { kind: 'absent' },
    content,
  };
}
const A = make('alpha', 'アルファの記憶', '# アルファの本文');
const B = make('beta', 'ベータの記憶', '# ベータの本文');
const DOCS = [A, B];

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
  return <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />;
}

/** 本番と同じ入れ子（`routes.ts`）。 */
function renderAt(url: string) {
  stubFetch((u) => {
    const one = /\/memory\/(alpha|beta)(\?|$)/.exec(u);
    if (one !== null) {
      const found = DOCS.find((d) => d.slug === one[1]);
      return found === undefined ? undefined : json({ document: found });
    }
    if (u.includes('/memory')) {
      return json({ documents: DOCS.map((d) => ({ ...d, content: undefined })) });
    }
    return undefined;
  });
  const router = createMemoryRouter(
    [
      {
        path: '/memory',
        Component: Memory,
        children: [{ path: ':slug', Component: DetailRoute }],
      },
      { path: '/practices', Component: () => null },
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

describe('記憶の一覧＋詳細', () => {
  it('/memory/:slug を直接開くと、左に一覧・右に中身が出て、選択中の行が現在地になる', async () => {
    renderAt('/memory/beta');

    const nav = await screen.findByRole('navigation', { name: '記憶の一覧' });
    expect(nav.className.split(/\s+/)).toContain('overflow-y-auto');
    expect(await within(nav).findAllByRole('link')).toHaveLength(2);
    expect(current(nav)).toEqual(['/memory/beta']);

    const detail = screen.getByRole('region', { name: '記憶の中身' });
    expect(
      await within(detail).findByRole('heading', { level: 1, name: 'ベータの本文' }),
    ).toBeTruthy();
    expect(within(detail).getByRole('heading', { level: 2, name: 'beta' })).toBeTruthy();
    expect(within(detail).getByRole('button', { name: '削除' })).toBeTruthy();
    expect(detail.textContent).not.toContain('undefined');
    expect(screen.queryByRole('button', { name: '記憶の一覧を開く' })).toBeNull();
    // 名前を入れて開く欄は一覧の上に残る。
    expect(screen.getByLabelText(/^名前/)).toBeTruthy();
  });

  it('/memory（未選択）では右に案内が出て、現在地の行は無い', async () => {
    renderAt('/memory');

    await screen.findByText('アルファの記憶');
    const detail = screen.getByRole('region', { name: '記憶の中身' });
    expect(within(detail).getByText(/左の一覧から記憶を選ぶ/)).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: '記憶の一覧' }))
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  it('名前を入れて Enter で、その記憶の画面へ移る', async () => {
    const router = renderAt('/memory');

    const input = await screen.findByLabelText(/^名前/);
    fireEvent.change(input, { target: { value: 'new-one' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(router.state.location.pathname).toBe('/memory/new-one'));
  });

  it('一覧の行を押すと右の中身が切り替わる', async () => {
    const router = renderAt('/memory/alpha');

    const nav = await screen.findByRole('navigation', { name: '記憶の一覧' });
    const links = await within(nav).findAllByRole('link');
    fireEvent.click(links[1] as HTMLElement);

    await waitFor(() => expect(router.state.location.pathname).toBe('/memory/beta'));
    expect(await screen.findByRole('heading', { level: 1, name: 'ベータの本文' })).toBeTruthy();
    await waitFor(() => expect(current(nav)).toEqual(['/memory/beta']));
  });

  describe('未保存の編集', () => {
    async function startEditing() {
      const detail = await screen.findByRole('region', { name: '記憶の中身' });
      fireEvent.mouseDown(await within(detail).findByRole('tab', { name: '編集' }));
      const textarea = (await within(detail).findByRole('textbox')) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: '書きかけ' } });
    }

    it('左の一覧で別の項目を押すと確認が出る。やめれば留まり、下書きも残る', async () => {
      const router = renderAt('/memory/alpha');
      await startEditing();

      const nav = screen.getByRole('navigation', { name: '記憶の一覧' });
      fireEvent.click(within(nav).getByRole('link', { name: /ベータの記憶/ }));

      expect(await screen.findByRole('alertdialog')).toBeTruthy();
      expect(router.state.location.pathname).toBe('/memory/alpha');
      fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(router.state.location.pathname).toBe('/memory/alpha');
      expect(
        (
          within(screen.getByRole('region', { name: '記憶の中身' })).getByRole(
            'textbox',
          ) as HTMLTextAreaElement
        ).value,
      ).toBe('書きかけ');
    });

    it('「破棄して離れる」で移り、移った先に前の下書きは持ち越されない', async () => {
      const router = renderAt('/memory/alpha');
      await startEditing();

      const nav = screen.getByRole('navigation', { name: '記憶の一覧' });
      fireEvent.click(within(nav).getByRole('link', { name: /ベータの記憶/ }));
      fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));

      await waitFor(() => expect(router.state.location.pathname).toBe('/memory/beta'));
      expect(await screen.findByRole('heading', { level: 1, name: 'ベータの本文' })).toBeTruthy();
      expect(screen.queryByText('書きかけ')).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('変更が無ければ確認なしで移る（保存の表示などは次の記憶へ持ち越さない）', async () => {
      const router = renderAt('/memory/alpha');
      await screen.findByRole('heading', { level: 1, name: 'アルファの本文' });

      const nav = screen.getByRole('navigation', { name: '記憶の一覧' });
      fireEvent.click(within(nav).getByRole('link', { name: /ベータの記憶/ }));

      await waitFor(() => expect(router.state.location.pathname).toBe('/memory/beta'));
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  describe('スマホ幅', () => {
    it('中身が全幅で出て、「記憶の一覧を開く」でドロワーに一覧が出る', async () => {
      setViewportWidth(390);
      renderAt('/memory/alpha');

      expect(await screen.findByRole('button', { name: '削除' })).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: '記憶の一覧' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '記憶の一覧を開く' }));
      const nav = await screen.findByRole('navigation', { name: '記憶の一覧' });
      expect(await within(nav).findAllByRole('link')).toHaveLength(2);
      expect(current(nav)).toEqual(['/memory/alpha']);
    });

    it('/memory では一覧が全幅で出る（中身の領域もボタンも無い）', async () => {
      setViewportWidth(390);
      renderAt('/memory');

      expect(await screen.findByText('アルファの記憶')).toBeTruthy();
      expect(screen.queryByRole('region', { name: '記憶の中身' })).toBeNull();
      expect(screen.queryByRole('button', { name: '記憶の一覧を開く' })).toBeNull();
    });
  });
});
