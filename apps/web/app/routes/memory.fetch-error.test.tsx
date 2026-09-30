// @vitest-environment jsdom
/**
 * 記憶の一覧の取得に失敗したとき、「まだ空。起動直後」を並べない（issue #2324）。
 *
 * 失敗を「正常」「正しい動作」と言い切ることになる（AGENTS.md の地雷「取れない軸に 0 の行を
 * 作る」）。手本は `approvals.fetch-error.test.tsx`（#2313）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Memory from './memory';

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

/** `GET /memory` にだけ `respond()` の応答を返す。他の URL は「繋がらない」。 */
function stubList(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/memory') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Memory }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('記憶の一覧の取得に失敗したとき（issue #2324）', () => {
  it('サーバの失敗（500）: エラーは出し、「まだ空。起動直後」は出さない', async () => {
    stubList(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/まだ空。起動直後/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「まだ空。起動直後」は出さない', async () => {
    stubList(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/まだ空。起動直後/)).toBeNull();
  });

  it('本当に0件なら、いままでどおり「まだ空。起動直後」と言う', async () => {
    stubList(() => json({ documents: [] }));
    renderPage();

    expect(await screen.findByText(/まだ空。起動直後/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
