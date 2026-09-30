// @vitest-environment jsdom
/**
 * 定期ジョブの一覧の取得に失敗したとき、「登録された定期ジョブが無い」を並べない（issue #2324）。
 *
 * 読めていないのにジョブが無い（`off` にしている可能性がある）と言い切ることになる（AGENTS.md の
 * 地雷「取れない軸に 0 の行を作る」）。手本は `approvals.fetch-error.test.tsx`（#2313）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Schedule from './schedule';

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

/** `GET /schedule` にだけ `respond()` の応答を返す。他の URL は「繋がらない」。 */
function stubSchedule(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/schedule') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Schedule }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('定期ジョブの一覧の取得に失敗したとき（issue #2324）', () => {
  it('サーバの失敗（500）: エラーは出し、「登録された定期ジョブが無い」は出さない', async () => {
    stubSchedule(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/登録された定期ジョブが無い/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「登録された定期ジョブが無い」は出さない', async () => {
    stubSchedule(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/登録された定期ジョブが無い/)).toBeNull();
  });

  it('本当に0件なら、いままでどおり「登録された定期ジョブが無い」と言う', async () => {
    stubSchedule(() => json({ entries: [] }));
    renderPage();

    expect(await screen.findByText(/登録された定期ジョブが無い/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
