// @vitest-environment jsdom
/**
 * `GET /approvals` の応答が `approvals` の配列を持たない形のとき（版のずれ）の承認待ちの画面
 * （issue #2308。外枠 `shell.tsx` は PR #2307、ダッシュボードは PR #2309 が同じ形で直す）。
 *
 * 測る保証は3つ — (1) 画面が落ちない（React Router の既定の ErrorBoundary に捕まらない）
 * (2) 「読めていない」と言う (3) 0件（「答えを待っているものはない」）として描かれない。
 * 型は `approvals` を配列と言っているので、ここが守るのは実行時の倒れ先だけである。
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

/** `GET /approvals` にだけ `body` を返す。他の URL は「繋がらない」。 */
function stubApprovalsBody(body: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/approvals') return json(body);
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Approvals,
        // 画面が落ちると、これが代わりに出る。
        ErrorBoundary: () => <div>画面が落ちた</div>,
      },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('形の違う承認待ちの応答（issue #2308）', () => {
  const cases: [string, unknown][] = [
    ['approvals の鍵が無い', { ok: true }],
    ['approvals が null', { approvals: null }],
    ['approvals が配列でない（文字列）', { approvals: 'oops' }],
  ];

  for (const [label, body] of cases) {
    it(`${label}: 落ちず、「読めていない」と言い、0件と描かない`, async () => {
      stubApprovalsBody(body);
      renderPage();

      expect(await screen.findByText(/承認待ちの一覧が読めない形で届いた/)).toBeTruthy();
      expect(screen.queryByText('画面が落ちた')).toBeNull();
      expect(screen.queryByText(/答えを待っているものはない/)).toBeNull();
      expect(screen.queryByText(/記録がまだない/)).toBeNull();
    });
  }

  it('unreadable が配列でなくても落ちない（読めた一覧はそのまま出す）', async () => {
    stubApprovalsBody({ approvals: [], unreadable: 'oops' });
    renderPage();

    expect(await screen.findByText(/答えを待っているものはない/)).toBeTruthy();
    expect(screen.queryByText('画面が落ちた')).toBeNull();
  });
});
