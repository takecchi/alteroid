// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MANAGERS_PAGE } from '@alteroid/swr';
import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Managers from './managers';

const BASE: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
};

function firstPage(count: number): ManagerSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    managerId: `mgr-${index}`,
    request: `req-mgr-${index}`,
    startedAt: new Date(Date.UTC(2026, 7, 16, 3, 0, 0) - index * 60_000).toISOString(),
  }));
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

function pageText(): string {
  return document.body.textContent ?? '';
}

describe('読み足した頁の取り直しの失敗（issue #3092）', () => {
  it('2頁目の取り直しが失敗しても、古い行は残したまま、その場で失敗を言う。通れば消える', async () => {
    let olderFailing = false;
    stubFetch((url) => {
      if (!url.includes('/managers')) return undefined;
      if (url.includes('afterId=')) {
        if (olderFailing) return json({ error: 'internal' }, 500);
        return json({
          managers: [
            {
              ...BASE,
              managerId: `mgr-${MANAGERS_PAGE}`,
              request: `req-mgr-${MANAGERS_PAGE}`,
              startedAt: new Date(
                Date.UTC(2026, 7, 16, 3, 0, 0) - MANAGERS_PAGE * 60_000,
              ).toISOString(),
            },
          ],
        });
      }
      return json({ managers: firstPage(MANAGERS_PAGE) });
    });
    const router = createMemoryRouter([{ path: '/', Component: Managers }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    await waitFor(() => expect(pageText()).toContain('req-mgr-0'));
    fireEvent.click(screen.getByText(/^もっと見る（いま \d+ 件）$/).closest('button')!);
    await waitFor(() => expect(pageText()).toContain(`req-mgr-${MANAGERS_PAGE}`));
    expect(pageText()).not.toContain('取り直せなかった');

    olderFailing = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(pageText()).toContain('取り直せなかった'));
    expect(pageText()).toContain(`req-mgr-${MANAGERS_PAGE}`);

    olderFailing = false;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(pageText()).not.toContain('取り直せなかった'));
    expect(pageText()).toContain(`req-mgr-${MANAGERS_PAGE}`);
  });
});
