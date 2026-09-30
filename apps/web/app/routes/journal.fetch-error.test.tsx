// @vitest-environment jsdom
/**
 * 日誌の取得に失敗したとき、「この条件では何も記録されていない」を並べない（issue #2322）。
 *
 * 失敗したのに0件の文言が並ぶと、読めていないのに記録が無いように読める
 * （AGENTS.md の地雷「取れない軸に 0 の行を作る」）。手本は `approvals.fetch-error.test.tsx`
 * （#2313）。日誌の行は jsdom では描かれない（`journal.test.tsx` の冒頭）ので、
 * 再検証の失敗で一覧が残る形は、ここでは測らない。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalFeedProvider } from '@alteroid/swr';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Journal from './journal';

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

/** `GET /journal` にだけ `respond()` の応答を返す。他の URL は「繋がらない」。 */
function stubJournal(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/journal') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage(initialEntry = '/') {
  const router = createMemoryRouter([{ path: '/', Component: Journal }], {
    initialEntries: [initialEntry],
  });
  render(
    <Providers>
      <JournalFeedProvider value={{ status: 'live', recent: [] }}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
}

describe('日誌の取得に失敗したとき（issue #2322）', () => {
  it('サーバの失敗（500）: エラーは出し、「何も記録されていない」は出さない', async () => {
    stubJournal(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/何も記録されていない/)).toBeNull();
  });

  it('通信の失敗: エラーは出し、「何も記録されていない」は出さない', async () => {
    stubJournal(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/何も記録されていない/)).toBeNull();
  });

  it('絞り込み中の失敗: エラーは出し、絞り込みの0件の文言は出さない', async () => {
    stubJournal(() => json({ error: 'internal' }, 500));
    renderPage('/?types=decision');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/に当たる記録は無い/)).toBeNull();
    expect(screen.queryByText(/何も記録されていない/)).toBeNull();
  });

  it('本当に0件なら、いままでどおり「何も記録されていない」と言う', async () => {
    stubJournal(() => json({ entries: [] }));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('この条件では何も記録されていない。')).toBeTruthy(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
