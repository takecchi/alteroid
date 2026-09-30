// @vitest-environment jsdom
/**
 * 日報の一覧と本文の取得に失敗したとき、「まだ無い」「日報が1件も無い」「この日の日報は無い」を
 * 並べない（issue #2324）。
 *
 * 読めていないのに日報が無いように読める（AGENTS.md の地雷「取れない軸に 0 の行を作る」）。
 * 一覧（`GET /reports`）と本文（`GET /reports/{date}`）は別の取得なので、両方を見る。
 * 手本は `approvals.fetch-error.test.tsx`（#2313）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Reports from './reports';

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

type Respond = () => Response | Promise<Response>;

/** 一覧（`GET /reports`）と本文（`GET /reports/{date}`）に別々の応答を返す。他の URL は「繋がらない」。 */
function stubReports(list: Respond, body: Respond): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(url).pathname;
    if (pathname === '/reports') return list();
    if (pathname.startsWith('/reports/')) return body();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

// framework mode の `loaderData` を手で与える（`reports.test.tsx` と同じやり方）。
const ReportsRoute = Reports as unknown as (props: {
  loaderData: { date: string | undefined; reportId: string | undefined };
}) => React.ReactElement;

function renderPage(date?: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/reports',
        Component: () => <ReportsRoute loaderData={{ date, reportId: undefined }} />,
      },
    ],
    { initialEntries: ['/reports'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const fail500: Respond = () => json({ error: 'internal' }, 500);
const failNetwork: Respond = () => Promise.reject(new TypeError('Failed to fetch'));

describe('日報の一覧の取得に失敗したとき（issue #2324）', () => {
  it.each([
    ['サーバの失敗（500）', fail500],
    ['通信の失敗', failNetwork],
  ])('%s: エラーは出し、一覧の「まだ無い」と右の「日報が1件も無い」は出さない', async (_, fail) => {
    stubReports(fail, fail);
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('まだ無い。')).toBeNull();
    expect(screen.queryByText(/日報が1件も無い/)).toBeNull();
  });

  it('本当に0件なら、いままでどおり「まだ無い」と「日報が1件も無い」を言う', async () => {
    stubReports(
      () => json({ reports: [] }),
      () => json({ reports: [] }),
    );
    renderPage();

    expect(await screen.findByText('まだ無い。')).toBeTruthy();
    expect(screen.getByText(/日報が1件も無い/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('日報の本文の取得に失敗したとき（issue #2324）', () => {
  const listOk: Respond = () =>
    json({
      reports: [
        {
          type: 'daily_report',
          id: 'r1',
          at: '2026-08-14T22:00:00.000Z',
          date: '2026-08-14',
          body: '',
        },
      ],
    });

  it.each([
    ['サーバの失敗（500）', fail500],
    ['通信の失敗', failNetwork],
  ])('%s: エラーは出し、「この日の日報は無い」は出さない', async (_, fail) => {
    stubReports(listOk, fail);
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('この日の日報は無い。')).toBeNull();
  });

  it('その日の日報が本当に無いなら、いままでどおり「この日の日報は無い」と言う', async () => {
    stubReports(listOk, () => json({ reports: [] }));
    renderPage();

    expect(await screen.findByText('この日の日報は無い。')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
