// @vitest-environment jsdom
import type { AnsweredApprovalDate } from '@alteroid/logic';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAnsweredDatesWindow } from './use-answered-dates-window';
import { json, Providers, storeTestBaseUrl, stubFetch } from '../test-support';

function day(n: number): AnsweredApprovalDate {
  return { date: `2026-10-${String(n).padStart(2, '0')}`, count: 1 };
}

function daemon(
  store: () => AnsweredApprovalDate[],
  failBefore?: () => boolean,
): Parameters<typeof stubFetch>[0] {
  return (url) => {
    if (!url.includes('/approvals/answered-dates')) return undefined;
    const q = new URL(url).searchParams;
    const limit = Number(q.get('limit'));
    const beforeDate = q.get('beforeDate');
    if (beforeDate !== null && failBefore?.()) return json({ error: 'boom' }, 500);
    const rows = store().filter((r) => beforeDate === null || r.date < beforeDate);
    return json({ dates: rows.slice(0, limit) });
  };
}

let win: ReturnType<typeof useAnsweredDatesWindow>;
function Probe() {
  const current = useAnsweredDatesWindow(3);
  useLayoutEffect(() => {
    win = current;
  });
  return <div data-testid="ids">{current.dates.map((r) => r.date.slice(8)).join(',')}</div>;
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

describe('useAnsweredDatesWindow: 先頭の頁がずれたときの隙間', () => {
  it('読み足し → 先頭に新しい日 → 境目の日が一覧に残る（読み足した分も残る）', async () => {
    let store = [9, 8, 7, 6, 5, 4, 3].map(day);
    stubFetch(daemon(() => store));
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(ids()).toBe('09,08,07'));
    act(() => win.loadOlder());
    await waitFor(() => expect(ids()).toBe('09,08,07,06,05,04'));

    store = [10, 9, 8, 7, 6, 5, 4, 3].map(day);
    await act(() => win.first.mutate());
    await waitFor(() => expect(ids()).toBe('10,09,08,07,06,05,04'));
  });

  it('隙間が無いまま先頭の頁が取り直されても、余分に読まない', async () => {
    const store = [9, 8, 7, 6, 5, 4, 3].map(day);
    const stub = stubFetch(daemon(() => store));
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(ids()).toBe('09,08,07'));
    act(() => win.loadOlder());
    await waitFor(() => expect(ids()).toBe('09,08,07,06,05,04'));

    const calls = stub.calls.length;
    await act(() => win.first.mutate());
    await waitFor(() => expect(stub.calls.length).toBe(calls + 1));
    await act(() => Promise.resolve());
    expect(stub.calls.length).toBe(calls + 1);
    expect(ids()).toBe('09,08,07,06,05,04');
  });

  it('隙間を埋める読み足しが失敗しても一覧は消えず、olderError に載る。自動では撃ち直さず、押し直すと埋まる', async () => {
    let store = [9, 8, 7, 6, 5, 4, 3].map(day);
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
    await waitFor(() => expect(ids()).toBe('09,08,07'));
    act(() => win.loadOlder());
    await waitFor(() => expect(ids()).toBe('09,08,07,06,05,04'));

    fail = true;
    store = [10, 9, 8, 7, 6, 5, 4, 3].map(day);
    await act(() => win.first.mutate());
    await waitFor(() => expect(win.olderError).toBeDefined());
    expect(ids()).toBe('10,09,08,06,05,04');
    const calls = stub.calls.length;
    await act(() => Promise.resolve());
    expect(stub.calls.length).toBe(calls);

    fail = false;
    act(() => win.loadOlder());
    await waitFor(() => expect(ids()).toBe('10,09,08,07,06,05,04'));
    expect(win.olderError).toBeUndefined();
  });
});
