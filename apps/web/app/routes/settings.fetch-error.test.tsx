// @vitest-environment jsdom
/**
 * runner の名簿（`GET /runners`）の取得に失敗したとき、「登録された実行環境が無い」を並べない
 * （issue #2324）。
 *
 * 読めていないのに runner が0台だと言い切ることになる（状態の断定。AGENTS.md の地雷「取れない軸に
 * 0 の行を作る」）。手本は `approvals.fetch-error.test.tsx`（#2313）。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Settings from './settings';

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

/**
 * `GET /runners` にだけ `respond()` の応答を返す。他の口（認証・接続の札）はこの試験の対象
 * ではないので、空の応答を返す（`settings.test.tsx` と同じ）。
 */
function stubRunners(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    if (pathname === '/runners') return respond();
    if (pathname === '/auth/providers') return json({ providers: [] });
    if (pathname === '/me') return json({ status: 'open' });
    if (pathname === '/health') return json({ ok: true });
    return json({});
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/** runner のカード（他のカードの注記と混ざらないよう、ここだけを見る）。 */
function runnersCard(): HTMLElement {
  const card = screen.getByRole('heading', { name: '実行環境（runner）' }).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error('runner のカードが見つからない');
  return card;
}

describe('runner の名簿の取得に失敗したとき（issue #2324）', () => {
  it('サーバの失敗（500）: エラーは出し、「登録された実行環境が無い」は出さない', async () => {
    stubRunners(() => json({ error: 'internal' }, 500));
    renderPage();

    await waitFor(() => expect(within(runnersCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/登録された実行環境が無い/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「登録された実行環境が無い」は出さない', async () => {
    stubRunners(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    await waitFor(() => expect(within(runnersCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/登録された実行環境が無い/)).toBeNull();
  });

  it('本当に0台なら、いままでどおり「登録された実行環境が無い」と言う', async () => {
    stubRunners(() => json({ runners: [], daemonRevision: { status: 'unknown' } }));
    renderPage();

    expect(await screen.findByText(/登録された実行環境が無い。/)).toBeTruthy();
    expect(within(runnersCard()).queryByRole('alert')).toBeNull();
  });
});
