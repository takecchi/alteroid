// @vitest-environment jsdom
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

function historyCard(): HTMLElement {
  const card = screen
    .getByRole('heading', { name: '切り替えの履歴（エラー状況）' })
    .closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error('切り替えの履歴のカードが見つからない');
  return card;
}

describe('切り替えの履歴の取得に失敗したとき（issue #2324）', () => {
  it('サーバの失敗（500）: エラーは出し、「まだ1件も無い」と Badge の 0 は出さない', async () => {
    stubJournal(() => json({ error: 'internal' }, 500));
    renderPage();

    await waitFor(() => expect(within(historyCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/切り替えの記録がまだ1件も無い/)).toBeNull();
    expect(within(historyCard()).queryByText('0')).toBeNull();
  });

  it('通信の失敗: エラーは出し、「まだ1件も無い」と Badge の 0 は出さない', async () => {
    stubJournal(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    await waitFor(() => expect(within(historyCard()).getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/切り替えの記録がまだ1件も無い/)).toBeNull();
    expect(within(historyCard()).queryByText('0')).toBeNull();
  });

  it('本当に0件なら、いままでどおり「まだ1件も無い」と Badge の 0 を出す', async () => {
    stubJournal(() => json({ entries: [] }));
    renderPage();

    expect(await screen.findByText('切り替えの記録がまだ1件も無い。')).toBeTruthy();
    expect(within(historyCard()).getByText('0')).toBeTruthy();
    expect(within(historyCard()).queryByRole('alert')).toBeNull();
  });
});

describe('切り替えの履歴を読み込んでいる間（issue #3070）', () => {
  it('読み込み中は Badge の 0 を出さず、読めたら件数を出す', async () => {
    let release: (res: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    stubJournal(() => pending);
    renderPage();

    const card = await waitFor(() => historyCard());
    expect(within(card).queryByText('0')).toBeNull();
    expect(screen.queryByText('切り替えの記録がまだ1件も無い。')).toBeNull();

    release(json({ entries: [] }));
    expect(await screen.findByText('切り替えの記録がまだ1件も無い。')).toBeTruthy();
    expect(within(historyCard()).getByText('0')).toBeTruthy();
  });
});
