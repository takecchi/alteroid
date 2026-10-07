// @vitest-environment jsdom
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryRouter, RouterProvider } from 'react-router';

import {
  json,
  Providers,
  storeTestBaseUrl,
  stubFetch,
  type FetchStub,
  type Route,
} from '~/test-support';

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
const BEFORE_MIDNIGHT = new Date('2026-08-14T14:59:30.000Z');

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

function usageBody(url: string, costUsd: number) {
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
  };
}

function usageCalls(calls: string[]): URL[] {
  return calls.filter((url) => url.includes('/usage')).map((url) => new URL(url));
}

function detailHref(): string | null {
  const link = screen
    .getAllByRole('link', { name: '詳しく見る' })
    .find((l) => (l.getAttribute('href') ?? '').startsWith('/usage'));
  return link?.getAttribute('href') ?? null;
}

function usageRoute(cost: { value: number | 'fail' }): Route {
  const base = homeRoute();
  return (url, init) => {
    if (!url.includes('/usage')) return base(url, init);
    return cost.value === 'fail'
      ? json({ error: 'internal' }, 500)
      : json(usageBody(url, cost.value));
  };
}

function renderHomeWith(cost: { value: number | 'fail' }): FetchStub {
  const stub = stubFetch(usageRoute(cost));
  const router = createMemoryRouter([{ path: '/', Component: Dashboard }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return stub;
}

describe('「今日の利用」の定期更新（issue #3699）', () => {
  it('30 秒たつと使用量を取り直し、金額が動く（29 秒では取り直さない）', async () => {
    const cost = { value: 0.02 as number | 'fail' };
    const stub = renderHomeWith(cost);
    await tick(10);
    expect(screen.getByText('$0.0200')).toBeTruthy();
    const before = usageCalls(stub.calls).length;

    cost.value = 0.05;
    await tick(29_000 - 10);
    expect(usageCalls(stub.calls)).toHaveLength(before);
    expect(screen.queryByText('$0.0500')).toBeNull();

    await tick(1_100);
    expect(usageCalls(stub.calls).length).toBe(before + 1);
    expect(screen.getByText('$0.0500')).toBeTruthy();
  });

  it('日をまたぐと、窓と「詳しく見る」の日付が新しい日になる', async () => {
    vi.setSystemTime(BEFORE_MIDNIGHT);
    const cost = { value: 0.02 as number | 'fail' };
    const stub = renderHomeWith(cost);
    await tick(10);
    expect(detailHref()).toBe('/usage?from=2026-08-14&to=2026-08-14');
    const first = usageCalls(stub.calls).at(-1)!;
    expect(first.searchParams.get('from')).toBe('2026-08-12');
    expect(first.searchParams.get('to')).toBe('2026-08-16');

    await tick(61_000);
    const last = usageCalls(stub.calls).at(-1)!;
    expect(last.searchParams.get('from')).toBe('2026-08-13');
    expect(last.searchParams.get('to')).toBe('2026-08-17');
    expect(detailHref()).toBe('/usage?from=2026-08-15&to=2026-08-15');
  });

  it('同じ日のうちは分が進んでも窓が変わらず、取り直しは 30 秒ごとだけである', async () => {
    const cost = { value: 0.02 as number | 'fail' };
    const stub = renderHomeWith(cost);
    await tick(10);
    const before = usageCalls(stub.calls).length;

    await tick(5 * 60_000);
    const calls = usageCalls(stub.calls);
    expect(calls.length - before).toBe(10);
    const windows = new Set(
      calls.map((u) => `${u.searchParams.get('from')}..${u.searchParams.get('to')}`),
    );
    expect(windows).toEqual(new Set(['2026-08-12..2026-08-16']));
  });

  it('定期更新の取り直しが失敗しても、前の値を残して注記する（#3346）', async () => {
    const cost = { value: 0.02 as number | 'fail' };
    renderHomeWith(cost);
    await tick(10);
    expect(screen.getByText('$0.0200')).toBeTruthy();

    cost.value = 'fail';
    await tick(30_100);
    expect(screen.getByText(/最新の利用を取り直せなかった/)).toBeTruthy();
    expect(screen.getByText('$0.0200')).toBeTruthy();
  });
});
