// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '@alteroid/logic';
import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import ManagerDetail, { clientLoader } from './manager-detail';
import type { Route } from './+types/manager-detail';
import Managers from './managers';

const A: ManagerSummary = {
  managerId: 'mgr-a',
  status: 'running',
  live: true,
  cwd: '/work/a',
  request: '一つ目の依頼の要旨',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
};
const B: ManagerSummary = {
  ...A,
  managerId: 'mgr-b',
  status: 'done',
  cwd: '/work/b',
  request: '二つ目の依頼の要旨',
};

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
  const { id } = useParams();
  const loaderData = clientLoader({ params: { id } } as Route.ClientLoaderArgs);
  return <ManagerDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function renderAt(url: string) {
  stubFetch((u) => {
    const detail = /\/managers\/(mgr-[ab])(\?|$)/.exec(u);
    if (detail !== null) {
      const found = [A, B].find((m) => m.managerId === detail[1]);
      return found === undefined ? undefined : json({ manager: found });
    }
    if (u.includes('/managers')) return json({ managers: [A, B] });
    return undefined;
  });
  const router = createMemoryRouter(
    [
      {
        path: '/managers',
        Component: Managers,
        children: [{ path: ':id', Component: DetailRoute }],
      },
      { path: '/chat', Component: () => null },
      { path: '/journal', Component: () => null },
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

describe('マネージャーの一覧＋詳細', () => {
  it('/managers/:id を直接開くと、左に一覧・右に詳細が出て、選択中の行が現在地になる', async () => {
    renderAt('/managers/mgr-b');

    const nav = await screen.findByRole('navigation', { name: 'マネージャーの一覧' });
    expect(nav.className.split(/\s+/)).toContain('overflow-y-auto');
    const links = await within(nav).findAllByRole('link');
    expect(links).toHaveLength(2);
    const current = links.filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current.map((l) => l.getAttribute('href'))).toEqual(['/managers/mgr-b']);

    const detail = screen.getByRole('region', { name: 'マネージャーの詳細' });
    expect(await within(detail).findByRole('button', { name: '停止する' })).toBeTruthy();
    expect(
      within(detail).getByRole('heading', { level: 2, name: 'マネージャーの詳細' }),
    ).toBeTruthy();
    expect(detail.textContent).not.toContain('undefined');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'マネージャーの一覧を開く' })).toBeNull();
  });

  it('/managers（未選択）では右に案内が出る', async () => {
    renderAt('/managers');

    await screen.findByText('二つ目の依頼の要旨');
    const detail = screen.getByRole('region', { name: 'マネージャーの詳細' });
    expect(within(detail).getByText(/左の一覧からマネージャーを選ぶ/)).toBeTruthy();
    expect(
      screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });

  it('絞り込みのクエリが、詳細へのリンクに引き継がれる', async () => {
    renderAt('/managers/mgr-a?status=running,done');

    const nav = await screen.findByRole('navigation', { name: 'マネージャーの一覧' });
    const links = await within(nav).findAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/managers/mgr-a?status=running,done',
      '/managers/mgr-b?status=running,done',
    ]);
  });

  it('一覧の行を押すと右の詳細が切り替わり、クエリは保たれる', async () => {
    const router = renderAt('/managers/mgr-a?status=running,done');

    const nav = await screen.findByRole('navigation', { name: 'マネージャーの一覧' });
    const links = await within(nav).findAllByRole('link');
    fireEvent.click(links[1] as HTMLElement);

    await waitFor(() => expect(router.state.location.pathname).toBe('/managers/mgr-b'));
    expect(router.state.location.search).toBe('?status=running,done');
    await waitFor(() => {
      const now = within(nav)
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page');
      expect(now.map((l) => l.getAttribute('href'))).toEqual([
        '/managers/mgr-b?status=running,done',
      ]);
    });
  });

  describe('スマホ幅', () => {
    it('詳細が全幅で出て、「マネージャーの一覧を開く」でドロワーに一覧が出る', async () => {
      setViewportWidth(390);
      renderAt('/managers/mgr-a');

      expect(await screen.findByRole('button', { name: '停止する' })).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'マネージャーの一覧' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'マネージャーの一覧を開く' }));
      const nav = await screen.findByRole('navigation', { name: 'マネージャーの一覧' });
      const links = await within(nav).findAllByRole('link');
      expect(links).toHaveLength(2);
      expect(
        links
          .filter((l) => l.getAttribute('aria-current') === 'page')
          .map((l) => l.getAttribute('href')),
      ).toEqual(['/managers/mgr-a']);
    });

    it('/managers では一覧が全幅で出る（詳細の領域もボタンも無い）', async () => {
      setViewportWidth(390);
      renderAt('/managers');

      expect(await screen.findByText('一つ目の依頼の要旨')).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'マネージャーの詳細' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'マネージャーの一覧を開く' })).toBeNull();
    });
  });
});
