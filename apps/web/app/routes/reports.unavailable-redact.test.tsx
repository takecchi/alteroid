// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Reports from './reports';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

describe('日報の画面は「作れなかった理由」の秘密を、CLI と同じく伏せる', () => {
  it('作れなかった日の理由（SDK のエラー文）に入った鍵を出さず、地の文は言い換えずに残す', async () => {
    const entry = {
      type: 'daily_report',
      id: 'r2',
      at: '2026-08-20T22:00:00.000Z',
      date: '2026-08-20',
      body: '（この日の日報は作れなかった）',
      unavailable: `process exited 1: GH_TOKEN=${TOKEN}`,
    };
    stubFetch((url) => {
      if (url.includes('/reports')) return json({ reports: [entry] });
      return undefined;
    });
    const router = createMemoryRouter(
      [
        {
          path: '/reports',
          Component: () => <ReportsRoute loaderData={{ date: undefined, reportId: undefined }} />,
        },
        { path: '/journal', Component: () => null },
        { path: '/schedule', Component: () => null },
      ],
      { initialEntries: ['/reports'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    await screen.findByText('この日の日報は作れなかった');
    expect(document.body.textContent).toContain('process exited 1: GH_TOKEN=');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
