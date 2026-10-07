// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import EnvVars from './env-vars';

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

function stubCredentials(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/credentials') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: EnvVars }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

// 一覧のカードだけを見る: 置くフォームの ErrorNote と混ざるため
function listCard(): HTMLElement {
  const card = screen.getByRole('heading', { name: '一覧' }).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error('一覧のカードが見つからない');
  return card;
}

describe('環境変数の一覧の取得に失敗したとき（issue #2324）', () => {
  it('サーバの失敗（500）: エラーは出し、「まだ1件も無い」と Badge の 0 は出さない', async () => {
    stubCredentials(() => json({ error: 'internal' }, 500));
    renderPage();

    await waitFor(() => expect(within(listCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/まだ1件も無い/)).toBeNull();
    expect(within(listCard()).queryByText('0')).toBeNull();
  });

  it('通信の失敗: エラーは出し、「まだ1件も無い」と Badge の 0 は出さない', async () => {
    stubCredentials(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    await waitFor(() => expect(within(listCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/まだ1件も無い/)).toBeNull();
    expect(within(listCard()).queryByText('0')).toBeNull();
  });

  it('本当に0件なら、いままでどおり「まだ1件も無い」と Badge の 0 を出す', async () => {
    stubCredentials(() => json({ credentials: [] }));
    renderPage();

    expect(await screen.findByText(/置かれた環境変数がまだ1件も無い。/)).toBeTruthy();
    expect(within(listCard()).getByText('0')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('再検証の失敗で一覧が読めたまま残っているときは、一覧を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubCredentials(() => {
      calls += 1;
      if (calls === 1) {
        return json({
          credentials: [
            {
              name: 'FAKE_SETTING_NAME',
              scope: 'all',
              secret: false,
              value: 'fake-value',
              sha256: 'fake-sha',
              updatedAt: '2026-08-19T10:00:00.000Z',
            },
          ],
        });
      }
      return json({ error: 'internal' }, 500);
    });
    renderPage();

    expect(await screen.findByText('FAKE_SETTING_NAME')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('FAKE_SETTING_NAME')).toBeTruthy();
  });
});
