// @vitest-environment jsdom
/**
 * 承認待ちの一覧の取得に失敗したとき、「答えを待っているものはない」を並べない（issue #2313）。
 *
 * 失敗したのに0件の文言が並ぶと、読めていないのに承認待ちが無いように読める。オーナーが
 * 承認を見落とす原因になる（AGENTS.md の地雷「取れない軸に 0 の行を作る」）。形の違う応答は
 * `approvals.malformed.test.tsx`（#2308）が見ている。こちらは通信・サーバの失敗である。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

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

/** `GET /approvals` にだけ `respond()` の応答を返す。他の URL は「繋がらない」。 */
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
});
