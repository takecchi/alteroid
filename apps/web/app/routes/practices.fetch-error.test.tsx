// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Practices from './practices';

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

function stubList(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/practices') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Practices }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('やり方の一覧の取得に失敗したとき（issue #2324）', () => {
  it('サーバの失敗（500）: エラーは出し、「まだ1件も無い。これは正常な状態」は出さない', async () => {
    stubList(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/まだ1件も無い。これは正常な状態/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「まだ1件も無い。これは正常な状態」は出さない', async () => {
    stubList(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/まだ1件も無い。これは正常な状態/)).toBeNull();
  });

  it('本当に0件なら、いままでどおり「まだ1件も無い。これは正常な状態」と言う', async () => {
    stubList(() => json({ practices: [] }));
    renderPage();

    expect(await screen.findByText(/まだ1件も無い。これは正常な状態/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
