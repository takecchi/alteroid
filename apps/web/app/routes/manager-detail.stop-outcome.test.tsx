// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

const BASE: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
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

function Harness({ id }: { id: string }) {
  const loaderData = clientLoader({ params: { id } } as Route.ClientLoaderArgs);
  return <ManagerDetail {...({ loaderData } as Route.ComponentProps)} />;
}

// DELETE /managers/{id} は 200 で outcome を返す。`not_stopped` / `unknown` は「止まったと確かめられていない」
// 本物のデーモンは止まらなかった委譲を台帳に残したまま（status は running のまま）GET で返す。
function stubStop(outcome: 'stopped' | 'not_stopped' | 'unknown') {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // openapi-fetch は Request を渡すので、method は Request の側を見る
    const request = input instanceof Request ? input : new Request(input, init);
    const { url, method } = request;
    if (method === 'DELETE' && url.endsWith('/managers/mgr-1')) {
      return json({
        outcome,
        detail: outcome === 'stopped' ? '止めた。' : '止まったと確かめられなかった。',
      });
    }
    if (url.includes('/managers/mgr-1')) return json({ manager: BASE });
    throw new TypeError(`Failed to fetch: ${url}`);
  }) as typeof fetch;
}

function renderAndStop() {
  // routes.ts と同じ path
  const router = createMemoryRouter(
    [
      { path: '/managers/:id', Component: () => <Harness id="mgr-1" /> },
      { path: '/managers', Component: () => <p>マネージャー一覧</p> },
      { path: '/journal', Component: () => null },
    ],
    { initialEntries: ['/managers/mgr-1'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return async () => {
    fireEvent.click(await screen.findByRole('button', { name: '停止する' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '停止する' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  };
}

describe('停止の outcome（#4563）', () => {
  it.each(['not_stopped', 'unknown'] as const)(
    'DELETE が %s を返したとき、止まったかのように一覧へ戻らず、止まっていないと言う',
    async (outcome) => {
      stubStop(outcome);
      const stop = renderAndStop();
      await stop();

      // 詳細に留まり、止まったと確かめられていないことを言う
      expect(await screen.findByText(/止まったと確かめられなかった/)).toBeTruthy();
      expect(screen.queryByText('マネージャー一覧')).toBeNull();
      // もう一度止められる（停止の操作が残る）
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: '停止する' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
    },
  );

  it('対照: stopped なら今までどおり一覧へ戻る', async () => {
    stubStop('stopped');
    const stop = renderAndStop();
    await stop();
    expect(await screen.findByText('マネージャー一覧')).toBeTruthy();
  });
});
