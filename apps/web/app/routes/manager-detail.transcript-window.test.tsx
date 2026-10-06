// @vitest-environment jsdom
/**
 * セッションログ（生）は数 MB になりうるので、窓で区切って出し、「続きを表示」で伸ばす（issue #3348）。
 * 伏せ字は全体に掛けてから切る。
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

const MANAGER: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
};

/** 1行 100 文字ほど。先頭と末尾の行に目印、各行にトークンを入れる。 */
const LINES = Array.from({ length: 2500 }, (_, i) => `row-${i} ${TOKEN} ${'x'.repeat(60)}`);
const TRANSCRIPT = LINES.join('\n');

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

describe('セッションログ（生）の窓', () => {
  it('長いログは先頭の窓だけ出し、「続きを表示」で伸び、伏せ字が効いている', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const { pathname } = new URL(url);
      if (pathname === '/managers/mgr-1') return json({ manager: MANAGER });
      if (pathname === '/managers/mgr-1/transcript')
        return new Response(TRANSCRIPT, { status: 200, headers: { 'content-type': 'text/plain' } });
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

    const button = (await screen.findByText('セッションログ（生）'))
      .closest('div')
      ?.parentElement?.querySelector('button');
    if (!button) throw new Error('開くボタンが見つからない');
    fireEvent.click(button);

    const pre = await screen.findByTestId('manager-transcript');
    const first = pre.textContent ?? '';
    expect(first.length).toBeLessThanOrEqual(100_000);
    expect(first).toContain('row-0 ');
    expect(first).not.toContain('row-2499 ');
    expect(screen.getByText(/全体 .* 文字を表示しています/)).toBeTruthy();

    fireEvent.click(screen.getByText('続きを表示'));
    const second = screen.getByTestId('manager-transcript').textContent ?? '';
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.startsWith(first)).toBe(true);

    for (let guard = 0; guard < 20 && screen.queryByText('続きを表示'); guard += 1) {
      fireEvent.click(screen.getByText('続きを表示'));
    }
    const all = screen.getByTestId('manager-transcript').textContent ?? '';
    expect(all).toContain('row-2499 ');
    expect(screen.queryByText('続きを表示')).toBeNull();
    expect(screen.getByText(/全体を表示しています/)).toBeTruthy();
    // 伏せ字: トークンは窓のどこにも残らない。行の本体は残る。
    expect(all).not.toContain(TOKEN);
    expect(all.split('row-').length - 1).toBe(2500);
  });
});
