// @vitest-environment jsdom
/**
 * ホームの「今日の利用」は、開いたままでも更新される（issue #3699）。
 *
 * - 一定間隔（進捗と同じ 30 秒）で使用量を取り直す
 * - 日をまたいだら、窓（ブラウザの今日 ±2 日）と「詳しく見る」の日付が新しい日になる
 * - 分が進むだけでは鍵は変わらない（取り直しが増えない）
 * - 定期更新の取り直しが失敗しても、前の値を残して注記する（#3346 の形）
 *
 * **実時間を待たない**（偽のタイマーで時計を進める）。TZ は `dashboard.test.tsx` と同じ形で固定する。
 */
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

// 既定は日の真ん中（JST 08/14 12:00）。日付の境界は通らない。
const NOON = new Date('2026-08-14T03:00:00.000Z');
// 2026-08-14T14:59:30Z = JST 08/14 23:59:30。30 秒後に JST の日付が 08/15 になる。
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

/** 偽の時計を進め、その間に済む非同期（fetch・SWR の更新）を流す。 */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 利用の応答。`today` は呼ばれた窓の真ん中（from と to の中点）にして、サーバが今日を返す形にする。 */
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

/** 利用の応答を差し替える経路。`costUsd` の `'fail'` は 500。 */
function usageRoute(cost: { value: number | 'fail' }): Route {
  const base = homeRoute();
  return (url, init) => {
    if (!url.includes('/usage')) return base(url, init);
    return cost.value === 'fail'
      ? json({ error: 'internal' }, 500)
      : json(usageBody(url, cost.value));
  };
}

/** ホームを描く。最初の取得から `cost` の応答にする（描いた後に差し替えると、最初の応答が既定になる）。 */
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

    // JST 00:00 を過ぎる（分の時計が刻み、窓の鍵が新しい日になる）。
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
    // 30 秒ごと = 5 分で 10 回。分ごとに鍵が変わっていれば、これに分の数が上乗せされる。
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
