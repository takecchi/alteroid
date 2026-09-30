// @vitest-environment jsdom
/**
 * 回転の履歴（`GET /journal?type=token_rotation`）の取得に失敗したとき、「回転の記録がまだ
 * 1件も無い」と Badge の `0` を並べない（issue #2324）。
 *
 * 読めていないのに回転が一度も起きていないように読める（AGENTS.md の地雷「取れない軸に 0 の行を
 * 作る」）。上のプール一覧は既に `data === undefined ? null` で直っている。手本は
 * `approvals.fetch-error.test.tsx`（#2313）。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Tokens from './tokens';

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
 * `GET /tokens` は空のプールで成功させ、`GET /journal` にだけ `respond()` の応答を返す。
 * 他の URL は「繋がらない」。
 */
function stubJournal(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    if (pathname === '/tokens') {
      return json({ tokens: [], settings: { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 } });
    }
    if (pathname === '/journal') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Tokens }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/** 「回転の履歴」のカード（上のプール一覧の Badge・注記と混ざらないよう、ここだけを見る）。 */
function historyCard(): HTMLElement {
  const card = screen
    .getByRole('heading', { name: '回転の履歴（エラー状況）' })
    .closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error('回転の履歴のカードが見つからない');
  return card;
}

describe('回転の履歴の取得に失敗したとき（issue #2324）', () => {
  it('サーバの失敗（500）: エラーは出し、「まだ1件も無い」と Badge の 0 は出さない', async () => {
    stubJournal(() => json({ error: 'internal' }, 500));
    renderPage();

    await waitFor(() => expect(within(historyCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/回転の記録がまだ1件も無い/)).toBeNull();
    expect(within(historyCard()).queryByText('0')).toBeNull();
  });

  it('通信の失敗: エラーは出し、「まだ1件も無い」と Badge の 0 は出さない', async () => {
    stubJournal(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    await waitFor(() => expect(within(historyCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/回転の記録がまだ1件も無い/)).toBeNull();
    expect(within(historyCard()).queryByText('0')).toBeNull();
  });

  it('本当に0件なら、いままでどおり「まだ1件も無い」と Badge の 0 を出す', async () => {
    stubJournal(() => json({ entries: [] }));
    renderPage();

    expect(await screen.findByText('回転の記録がまだ1件も無い。')).toBeTruthy();
    expect(within(historyCard()).getByText('0')).toBeTruthy();
    expect(within(historyCard()).queryByRole('alert')).toBeNull();
  });
});
