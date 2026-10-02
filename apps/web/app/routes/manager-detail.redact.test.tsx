// @vitest-environment jsdom
/**
 * 委譲の画面の本文（依頼・最後の報告・生ログ）に伏せ字を掛ける（issue #2600）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

/** 偽のトークン（本物ではない）。 */
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

const MANAGER: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: `依頼 ${TOKEN} ${SHA}`,
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
  lastReport: `報告 ${TOKEN} ${SHA}`,
  lastReportAt: '2026-08-16T03:10:00.000Z',
};

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

function Harness() {
  const loaderData = clientLoader({ params: { id: 'mgr-1' } } as Route.ClientLoaderArgs);
  return <ManagerDetail {...({ loaderData } as Route.ComponentProps)} />;
}

describe('委譲の本文の伏せ字', () => {
  it('依頼・最後の報告・セッションログの生ログからトークンが消え、sha は残る', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const { pathname } = new URL(url);
      if (pathname === '/managers/mgr-1') return json({ manager: MANAGER });
      if (pathname === '/managers/mgr-1/transcript')
        return new Response(`生ログ ${TOKEN} ${SHA}`, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    const router = createMemoryRouter(
      [
        { path: '/managers/:id', Component: Harness },
        { path: '/journal', Component: () => null },
      ],
      { initialEntries: ['/managers/mgr-1'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    await screen.findByText('セッションログ（生）');
    const button = screen
      .getByText('セッションログ（生）')
      .closest('div')
      ?.parentElement?.querySelector('button');
    if (!button) throw new Error('開くボタンが見つからない');
    fireEvent.click(button);
    await screen.findByText(/生ログ /);

    const text = document.body.textContent ?? '';
    expect(text).not.toContain(TOKEN);
    expect(text).toContain(`依頼 `);
    expect(text).toContain(`報告 `);
    expect(text).toContain(`生ログ `);
    expect(text.split(SHA).length - 1).toBe(3);
  });
});
