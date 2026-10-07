// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function stubApprovals(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/approvals') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Approvals }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('承認待ちの一覧の取得に失敗したとき（issue #2313）', () => {
  it('サーバの失敗（500）: エラーは出し、「答えを待っているものはない」は出さない', async () => {
    stubApprovals(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/答えを待っているものはない/)).toBeNull();
    expect(screen.queryByText(/記録がまだない/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「答えを待っているものはない」は出さない', async () => {
    stubApprovals(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/答えを待っているものはない/)).toBeNull();
    expect(screen.queryByText(/記録がまだない/)).toBeNull();
  });

  it('本当に0件なら、いままでどおり「答えを待っているものはない」と言う', async () => {
    stubApprovals(() => json({ approvals: [] }));
    renderPage();

    expect(
      await screen.findByText(/答えを待っているものはない。クローンは進んでいる。/),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('再検証の失敗で一覧が読めたまま残っているときは、一覧を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubApprovals(() => {
      calls += 1;
      if (calls === 1) {
        return json({
          approvals: [
            {
              id: 'a-1',
              createdAt: '2026-08-19T10:00:00.000Z',
              updatedAt: '2026-08-19T10:00:00.000Z',
              question: '本番に出してよいか',
            },
          ],
        });
      }
      return json({ error: 'internal' }, 500);
    });
    renderPage();

    expect(await screen.findByText('本番に出してよいか')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('本番に出してよいか')).toBeTruthy();
  });
});
