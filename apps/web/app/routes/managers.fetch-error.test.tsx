// @vitest-environment jsdom
/**
 * マネージャー一覧の取得に失敗したとき、「まだマネージャーはいません」を並べない（issue #2322）。
 *
 * 失敗したのに0件の文言が並ぶと、読めていないのにマネージャーが居ないように読める
 * （AGENTS.md の地雷「取れない軸に 0 の行を作る」）。後続ページの失敗（`olderError`）は別扱いで、
 * ここでは見ない。手本は `approvals.fetch-error.test.tsx`（#2313）。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Managers from './managers';

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

/** `GET /managers` にだけ `respond()` の応答を返す。他の URL は「繋がらない」。 */
function stubManagers(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/managers') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage(initialEntry = '/') {
  const router = createMemoryRouter([{ path: '/', Component: Managers }], {
    initialEntries: [initialEntry],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('マネージャー一覧の取得に失敗したとき（issue #2322）', () => {
  it('サーバの失敗（500）: エラーは出し、「まだマネージャーはいません」は出さない', async () => {
    stubManagers(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/まだマネージャーはいません/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「まだマネージャーはいません」は出さない', async () => {
    stubManagers(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/まだマネージャーはいません/)).toBeNull();
  });

  it('絞り込み中の失敗: エラーは出し、「この状態のマネージャーは無い」は出さない', async () => {
    stubManagers(() => json({ error: 'internal' }, 500));
    renderPage('/?status=lost');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/この状態のマネージャーは無い/)).toBeNull();
    expect(screen.queryByText(/まだマネージャーはいません/)).toBeNull();
  });

  it('本当に0件なら、いままでどおり「まだマネージャーはいません」と言う', async () => {
    stubManagers(() => json({ managers: [] }));
    renderPage();

    expect(await screen.findByText(/まだマネージャーはいません/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('再検証の失敗で一覧が読めたまま残っているときは、一覧を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubManagers(() => {
      calls += 1;
      if (calls === 1) {
        return json({
          managers: [
            {
              managerId: 'mgr-1',
              status: 'running',
              live: true,
              cwd: '/work/project',
              request: 'PR を出して',
              startedAt: '2026-08-16T03:00:00.000Z',
              updatedAt: '2026-08-16T03:15:00.000Z',
              waiting: [],
            },
          ],
        });
      }
      return json({ error: 'internal' }, 500);
    });
    renderPage();

    expect(await screen.findByText('PR を出して')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    // 再検証を起こす（SWR は focus で再検証する。足場は throttle 0。chat.revalidate-error.test.tsx と同じ）。
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('PR を出して')).toBeTruthy();
  });
});
