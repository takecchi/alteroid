// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';
import type { Commitment } from '@alteroid/logic';

import Commitments from './commitments';

// 一覧は片付いた行の本文・閉じた理由を先頭に切って返す（#5089）。切られた行だけ「全文を見る」で GET /commitments/{id} から全文を取る

const AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const CLOSED_AT = new Date().toISOString();
const FULL_BODY = `頼まれた本文の頭。${'あ'.repeat(300)}本文の末尾`;
const FULL_REASON = `片付けた理由の頭。${'い'.repeat(300)}理由の末尾`;

function closed(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'closed-1',
    origin: 'human',
    at: AT,
    closedAt: CLOSED_AT,
    closedBy: 'human',
    updatedAt: CLOSED_AT,
    body: `${FULL_BODY.slice(0, 200)}…`,
    bodyTruncated: true,
    closedReason: `${FULL_REASON.slice(0, 200)}…`,
    closedReasonTruncated: true,
    ...over,
  };
}

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

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function stub(rows: Commitment[]) {
  return stubFetch((url) => {
    if (url.includes('/commitments/closed-1')) {
      return json({
        entry: {
          ...closed(),
          body: FULL_BODY,
          closedReason: FULL_REASON,
          bodyTruncated: undefined,
          closedReasonTruncated: undefined,
        },
      });
    }
    if (!url.includes('/commitments')) return undefined;
    return json({
      entries: url.includes('includeClosed=true') ? rows : [],
      unreadable: [],
      trimmedClosed: 0,
    });
  });
}

describe('片付いた行の全文（#5089）', () => {
  it('⭐ 切られた行には「全文を見る」が出て、押したときだけ詳細を取りに行き、全文で描き直す', async () => {
    const fetched = stub([closed()]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));

    expect(await screen.findByText(/頼まれた本文の頭。/)).toBeTruthy();
    expect(screen.queryByText(/本文の末尾/)).toBeNull();
    expect(fetched.calls.some((url) => url.includes('/commitments/closed-1'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '全文を見る' }));

    expect(await screen.findByText(/本文の末尾/)).toBeTruthy();
    expect(screen.getByText(/理由の末尾/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '全文を見る' })).toBeNull();
    expect(fetched.calls.some((url) => url.includes('/commitments/closed-1'))).toBe(true);
  });

  it('切られていない行には「全文を見る」を出さない', async () => {
    stub([
      closed({
        body: '短い本文',
        closedReason: '短い理由',
        bodyTruncated: undefined,
        closedReasonTruncated: undefined,
      }),
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));

    expect(await screen.findByText('短い本文')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '全文を見る' })).toBeNull();
  });
});
