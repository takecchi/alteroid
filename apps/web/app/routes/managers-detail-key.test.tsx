// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

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

describe('詳細の切り替え', () => {
  it('A の書きかけと停止の確認は、B へ切り替えても引き継がれない', async () => {
    const router = renderAt('/managers/mgr-a');
    await screen.findByRole('navigation', { name: 'マネージャーの一覧' });
    const detail = screen.getByRole('region', { name: 'マネージャーの詳細' });

    const box = (await within(detail).findByPlaceholderText('追加の指示')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'A 宛ての指示' } });
    expect(box.value).toBe('A 宛ての指示');
    fireEvent.click(within(detail).getByRole('button', { name: '停止する' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();

    // 行を押す代わりに経路を切り替える: 確認はモーダルで一覧を覆うため
    await act(async () => {
      void router.navigate('/managers/mgr-b');
    });
    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));

    await waitFor(() => {
      expect(
        screen
          .getAllByRole('link')
          .filter((l) => l.getAttribute('aria-current') === 'page')
          .map((l) => l.getAttribute('href')),
      ).toEqual(['/managers/mgr-b']);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    const boxB = (await within(
      screen.getByRole('region', { name: 'マネージャーの詳細' }),
    ).findByPlaceholderText('追加の指示')) as HTMLTextAreaElement;
    expect(boxB.value).toBe('');
  });

  it('詳細の外（一覧）は切り替えで作り直されない', async () => {
    renderAt('/managers/mgr-a');
    const nav = await screen.findByRole('navigation', { name: 'マネージャーの一覧' });
    fireEvent.click(await within(nav).findByRole('link', { name: /二つ目の依頼の要旨/ }));
    await waitFor(() => {
      expect(
        within(nav)
          .getAllByRole('link')
          .filter((l) => l.getAttribute('aria-current') === 'page')
          .map((l) => l.getAttribute('href')),
      ).toEqual(['/managers/mgr-b']);
    });
    expect(screen.getByRole('navigation', { name: 'マネージャーの一覧' })).toBe(nav);
  });
});
