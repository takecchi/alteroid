// @vitest-environment jsdom
/**
 * `apps/web` にこの画面のテストが1本も無かった。ここで測るのは
 * **「日報の本文が描画経路を通ること」だけ**（Markdown が正しく描かれるかは
 * `markdown.test.tsx` の仕事）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

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

// framework mode の `loaderData` を手で与える（`chat.test.tsx` と同じやり方）。
const ReportsRoute = Reports as unknown as (props: {
  loaderData: { date: string | undefined };
}) => React.ReactElement;

function renderReports() {
  const router = createMemoryRouter(
    [{ path: '/reports', Component: () => <ReportsRoute loaderData={{ date: undefined }} /> }],
    { initialEntries: ['/reports'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('日報', () => {
  it('最新の日報の本文が Markdown の描画経路を通って出る', async () => {
    stubFetch((url) => {
      if (url.endsWith('/reports') || url.includes('/reports?')) {
        return json({
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
      }
      if (url.includes('/reports/2026-08-14')) {
        return json({
          reports: [
            {
              type: 'daily_report',
              id: 'r1',
              at: '2026-08-14T22:00:00.000Z',
              date: '2026-08-14',
              body: '## 今日やったこと\n\n進捗があった。',
            },
          ],
        });
      }
      return undefined;
    });

    renderReports();

    expect(await screen.findByRole('heading', { name: '今日やったこと' })).toBeTruthy();
    expect(screen.getByText('進捗があった。')).toBeTruthy();
  });
});
