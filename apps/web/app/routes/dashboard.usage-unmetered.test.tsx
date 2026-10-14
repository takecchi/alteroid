// @vitest-environment jsdom
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryRouter, RouterProvider } from 'react-router';

import { json, Providers, storeTestBaseUrl, stubFetch } from '~/test-support';

import Dashboard from './dashboard';
import { homeRoute } from './dashboard-test-helpers';

const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

let originalFetch: typeof fetch;

const NOON = new Date('2026-08-14T03:00:00.000Z');

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.useFakeTimers({ now: NOON });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function usageBody(url: string, costUsd: number, unmetered: boolean) {
  const query = new URL(url).searchParams;
  const from = Date.parse(`${query.get('from')}T00:00:00Z`);
  const today = new Date(from + 2 * 86_400_000).toISOString().slice(0, 10);
  return {
    rows: [
      {
        date: today,
        managerId: 'm1',
        model: 'claude-opus-4',
        updatedAt: '2026-08-14T10:00:00.000Z',
        totals: { ...ZERO_USAGE, costUsd },
      },
    ],
    turnRows: [],
    since: '2026-08-01T00:00:00.000Z',
    beforeLedger: false,
    today,
    notice: USAGE_ESTIMATE_NOTICE,
    breakdown: null,
    unmeteredRows: unmetered
      ? [
          {
            date: today,
            managerId: 'clone',
            layer: 'clone',
            site: 'session',
            provider: 'codex',
            turns: 3,
            updatedAt: '2026-08-14T10:00:00.000Z',
          },
        ]
      : [],
  };
}

function renderHome(unmetered: boolean): void {
  const base = homeRoute();
  stubFetch((url, init) => {
    if (!url.includes('/usage')) return base(url, init);
    return json(usageBody(url, 0, unmetered));
  });
  const router = createMemoryRouter([{ path: '/', Component: Dashboard }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('「今日の利用」は、消費を報告しない provider のターンを 0 に見せない（#4800）', () => {
  it('⭐ 今日の無報告のターンがあれば、/usage と同じ「取れなかった」の注記を出す', async () => {
    renderHome(true);
    await tick(10);
    expect(screen.getByText(/消費を報告しない provider のターンがある/)).toBeTruthy();
  });

  it('対照: 無報告のターンが無ければ、注記は出さない', async () => {
    renderHome(false);
    await tick(10);
    expect(screen.queryByText(/消費を報告しない provider のターンがある/)).toBeNull();
  });
});
