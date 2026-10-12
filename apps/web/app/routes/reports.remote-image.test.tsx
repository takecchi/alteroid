// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
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

const ReportsRoute = Reports as unknown as (props: {
  loaderData: { date: string | undefined; reportId: string | undefined };
}) => React.ReactElement;

describe('日報の画面: 外部の画像（#4551）', () => {
  it('本文にある外部の画像は <img> にならず、リンクに落ちる（ホームの最新の日報と同じ扱い、#4062）', async () => {
    const full = {
      type: 'daily_report',
      id: 'r1',
      at: '2026-08-14T22:00:00.000Z',
      date: '2026-08-14',
      body: '![図](https://example.invalid/p.png)',
    };
    stubFetch((url) => {
      if (url.includes('/reports/2026-08-14')) return json({ reports: [full] });
      if (url.endsWith('/reports') || url.includes('/reports?')) return json({ reports: [full] });
      return undefined;
    });

    function Routed() {
      const { date, reportId } = useParams();
      return <ReportsRoute loaderData={{ date, reportId }} />;
    }
    const router = createMemoryRouter([{ path: '/reports/:date?/:reportId?', Component: Routed }], {
      initialEntries: ['/reports'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    const link = await screen.findByRole('link', { name: '画像: 図' });
    expect(link.getAttribute('href')).toBe('https://example.invalid/p.png');
    expect(document.querySelector('img')).toBeNull();
  });
});
