// @vitest-environment jsdom
/**
 * マネージャー詳細の取得に失敗したとき、「見つからない」「(空)」を出さない（issue #2321）。
 *
 * 読めていないのに委譲が存在しないように、セッションログが空だったように読める。
 * 「見つからない」は 404 のときだけの言葉で、それ以外の失敗は `ErrorNote` が言う
 * （AGENTS.md の地雷「取れない軸に 0 の行を作る」）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

const MANAGER: ManagerSummary = {
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

/** `GET /managers/mgr-1` と `GET /managers/mgr-1/transcript` に、それぞれの応答を返す。他は「繋がらない」。 */
function stubManager(routes: {
  detail?: () => Response | Promise<Response>;
  transcript?: () => Response | Promise<Response>;
}): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const { pathname } = new URL(url);
    if (pathname === '/managers/mgr-1' && routes.detail) return routes.detail();
    if (pathname === '/managers/mgr-1/transcript' && routes.transcript) return routes.transcript();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function Harness() {
  const loaderData = clientLoader({ params: { id: 'mgr-1' } } as Route.ClientLoaderArgs);
  return <ManagerDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/managers/:id', Component: Harness },
      { path: '/journal', Component: () => null },
    ],
    { initialEntries: ['/managers/mgr-1'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('詳細の取得に失敗したとき（issue #2321）', () => {
  it('サーバの失敗（500）: エラーは出し、「見つからない」は出さない', async () => {
    stubManager({ detail: () => json({ error: 'internal' }, 500) });
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/見つからない/)).toBeNull();
  });

  it('409（委譲の行は在るが読めない形。issue #2359）: サーバの言い分を出し、「見つからない」は出さない', async () => {
    stubManager({
      detail: () =>
        json(
          {
            error:
              'マネージャー mgr-1 は読めない形で入っている（消されたのではない）。理由: 不正な欄: status。本文はここでは取れない。',
          },
          409,
        ),
    });
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('読めない形で入っている');
    expect(screen.queryByText(/見つからない/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「見つからない」は出さない', async () => {
    stubManager({ detail: () => Promise.reject(new TypeError('Failed to fetch')) });
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/見つからない/)).toBeNull();
  });

  it('404 なら、「見つからない」と言う', async () => {
    stubManager({ detail: () => json({ error: 'not found' }, 404) });
    renderPage();

    expect(await screen.findByText('見つからない。')).toBeTruthy();
  });

  it('再検証の失敗で詳細が読めたまま残っているときは、詳細を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubManager({
      detail: () => {
        calls += 1;
        return calls === 1 ? json({ manager: MANAGER }) : json({ error: 'internal' }, 500);
      },
    });
    renderPage();

    expect(await screen.findByText('PR を出して')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    // 再検証を起こす（SWR は focus で再検証する。足場は throttle 0。approvals.fetch-error.test.tsx と同じ）。
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('PR を出して')).toBeTruthy();
  });
});

describe('セッションログの取得に失敗したとき（issue #2321）', () => {
  async function openTranscript() {
    renderPage();
    await screen.findByText('セッションログ（生）');
    // 詳細が読めたあと、ログの「開く」を押す（ほかに「開く」は無い前提で、ログの札の隣のものを選ぶ）。
    const title = screen.getByText('セッションログ（生）');
    const button = title.closest('div')?.parentElement?.querySelector('button');
    if (!button) throw new Error('開くボタンが見つからない');
    fireEvent.click(button);
  }

  it('サーバの失敗（500）: エラーは出し、「(空)」は出さない', async () => {
    stubManager({
      detail: () => json({ manager: MANAGER }),
      transcript: () => json({ error: 'internal' }, 500),
    });
    await openTranscript();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('(空)')).toBeNull();
  });

  it('本当に空なら、「(空)」と言う', async () => {
    stubManager({
      detail: () => json({ manager: MANAGER }),
      transcript: () =>
        new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    await openTranscript();

    expect(await screen.findByText('(空)')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
