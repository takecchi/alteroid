// @vitest-environment jsdom
import type { DailyReport } from '@alteroid/logic';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useReportsWindow } from './use-reports-window';
import { json, Providers, storeTestBaseUrl, stubFetch } from '../test-support';

function report(day: number): DailyReport {
  const date = `2026-10-${String(day).padStart(2, '0')}`;
  return { type: 'daily_report', id: `r-${day}`, at: `${date}T23:00:00.000Z`, date, body: 'b' };
}

function daemon(
  store: () => DailyReport[],
  failBefore?: () => boolean,
): Parameters<typeof stubFetch>[0] {
  return (url) => {
    if (!url.includes('/reports')) return undefined;
    const q = new URL(url).searchParams;
    const limit = Number(q.get('limit'));
    const beforeDate = q.get('beforeDate');
    if (beforeDate !== null && failBefore?.()) return json({ error: 'boom' }, 500);
    const beforeAt = q.get('beforeAt') ?? '';
    const rows = store().filter(
      (r) =>
        beforeDate === null || r.date < beforeDate || (r.date === beforeDate && r.at < beforeAt),
    );
    return json({ reports: rows.slice(0, limit) });
  };
}

let win: ReturnType<typeof useReportsWindow>;
function Probe() {
  const current = useReportsWindow(3);
  useLayoutEffect(() => {
    win = current;
  });
  return <div data-testid="ids">{current.reports.map((r) => r.id).join(',')}</div>;
}

const ids = () => screen.getByTestId('ids').textContent;
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

describe('useReportsWindow: 先頭の頁がずれたときの隙間', () => {
  it('読み足し → 先頭に新しい1件 → 境目の日報が一覧に残る（読み足した分も残る）', async () => {
    let store = [9, 8, 7, 6, 5, 4, 3].map(report);
    stubFetch(daemon(() => store));
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(ids()).toBe('r-9,r-8,r-7'));
    act(() => win.loadOlder());
    await waitFor(() => expect(ids()).toBe('r-9,r-8,r-7,r-6,r-5,r-4'));

    store = [10, 9, 8, 7, 6, 5, 4, 3].map(report);
    await act(() => win.first.mutate());
    await waitFor(() => expect(ids()).toBe('r-10,r-9,r-8,r-7,r-6,r-5,r-4'));
  });

  it('隙間を埋める読み足しが失敗しても一覧は消えず、olderError に載る。自動では撃ち直さず、押し直すと埋まる', async () => {
    let store = [9, 8, 7, 6, 5, 4, 3].map(report);
    let fail = false;
    const stub = stubFetch(
      daemon(
        () => store,
        () => fail,
      ),
    );
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(ids()).toBe('r-9,r-8,r-7'));
    act(() => win.loadOlder());
    await waitFor(() => expect(ids()).toBe('r-9,r-8,r-7,r-6,r-5,r-4'));

    fail = true;
    store = [10, 9, 8, 7, 6, 5, 4, 3].map(report);
    await act(() => win.first.mutate());
    await waitFor(() => expect(win.olderError).toBeDefined());
    expect(ids()).toBe('r-10,r-9,r-8,r-6,r-5,r-4');
    const calls = stub.calls.length;
    await act(() => Promise.resolve());
    expect(stub.calls.length).toBe(calls);

    fail = false;
    act(() => win.loadOlder());
    await waitFor(() => expect(ids()).toBe('r-10,r-9,r-8,r-7,r-6,r-5,r-4'));
    expect(win.olderError).toBeUndefined();
  });
});
