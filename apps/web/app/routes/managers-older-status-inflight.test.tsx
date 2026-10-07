// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive, MANAGERS_PAGE } from '@alteroid/swr';
import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Managers from './managers';

function pageText(): string {
  return document.body.textContent ?? '';
}

function buttonByText(label: RegExp): HTMLButtonElement {
  const button = screen.getByText(label).closest('button');
  if (button === null) throw new Error('ボタンとして描かれていない: ' + String(label));
  return button;
}

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

const PAGE1_ANCHOR_TIME = Date.UTC(2026, 7, 16, 3, 0, 0);

function firstPage(count: number): ManagerSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    managerId: `mgr-${index}`,
    request: `req-mgr-${index}`,
    status: 'running',
    startedAt: new Date(PAGE1_ANCHOR_TIME - index * 60_000).toISOString(),
  }));
}

function olderPage(prefix: string, count: number, anchorTime: number): ManagerSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    managerId: `${prefix}-${index}`,
    request: `req-${prefix}-${index}`,
    status: 'running',
    startedAt: new Date(anchorTime - index * 60_000).toISOString(),
  }));
}

function afterIdOf(url: string): string | null {
  return new URL(url).searchParams.get('afterId');
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

function Sentinel() {
  useJournalLive();
  return null;
}

function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sseRoute(trigger: { promise: Promise<void> }, init: RequestInit | undefined) {
  return sse(
    [
      {
        event: 'exchange',
        data: {
          type: 'exchange',
          id: 'e1',
          at: '2026-08-16T04:00:00.000Z',
          with: 'manager',
          role: 'inbound',
          text: '発言',
        },
        after: trigger.promise,
      },
    ],
    { keepOpen: true, signal: init?.signal },
  );
}

function renderManagers(route: Route) {
  const stub = stubFetch(route);
  const router = createMemoryRouter([{ path: '/', Component: Managers }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <Sentinel />
      <RouterProvider router={router} />
    </Providers>,
  );
  return stub;
}

async function waitForFirstPage() {
  await waitFor(() => {
    expect(pageText()).toContain('req-mgr-0');
  });
}

describe('runOlderRefresh は loadOlder() との競合を持ち込まない（issue #1998）', () => {
  it('loadOlder() が走っている間に届いた取り直しの結果では olderStatus を動かさない', async () => {
    const invalidateTrigger = makeGate();
    const r1Gate = makeGate();
    const loadOlderGate = makeGate();

    const pageA = olderPage('a', MANAGERS_PAGE, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000);
    const pageARefreshed = olderPage(
      'a2',
      MANAGERS_PAGE - 1,
      PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000,
    );
    const pageC = olderPage('c', MANAGERS_PAGE, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 3 * 60_000);

    let afterMgr49Calls = 0;

    const stub = renderManagers((url, init) => {
      if (url.endsWith('/journal/stream')) return sseRoute(invalidateTrigger, init);
      if (!url.includes('/managers')) return undefined;
      const afterId = afterIdOf(url);
      if (afterId === 'mgr-49') {
        afterMgr49Calls += 1;
        if (afterMgr49Calls === 1) return json({ managers: pageA });
        return r1Gate.promise.then(() => json({ managers: pageARefreshed }));
      }
      if (afterId === 'a-49') {
        return loadOlderGate.promise.then(() => json({ managers: pageC }));
      }
      if (afterId === null) return json({ managers: firstPage(MANAGERS_PAGE) });
      return json({ managers: [] });
    });

    await waitForFirstPage();

    fireEvent.click(buttonByText(/^もっと見る（いま \d+ 件）$/));
    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`);
    });

    invalidateTrigger.resolve();
    await waitFor(() => {
      expect(afterMgr49Calls).toBe(2);
    });

    fireEvent.click(buttonByText(/^もっと見る（いま \d+ 件）$/));
    await waitFor(() => {
      expect(buttonByText(/^読み込み中/)).toBeTruthy();
    });

    r1Gate.resolve();

    await waitFor(() => {
      expect(stub.calls.some((u) => afterIdOf(u) === 'mgr-49')).toBe(true);
    });
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
    expect(buttonByText(/^読み込み中/)).toBeTruthy();

    loadOlderGate.resolve();

    await waitFor(() => {
      expect(
        screen.getByText(
          `もっと見る（いま ${MANAGERS_PAGE + (MANAGERS_PAGE - 1) + MANAGERS_PAGE} 件）`,
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
  });

  it('取り直しの応答が届くまでに頁が足された（最後の頁の錨が変わった）ら olderStatus を動かさない', async () => {
    const invalidateTrigger = makeGate();
    const r1Gate = makeGate();

    const pageA = olderPage('a', MANAGERS_PAGE, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000);
    const pageARefreshed = olderPage(
      'a2',
      MANAGERS_PAGE - 1,
      PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000,
    );
    const pageC = olderPage('c', MANAGERS_PAGE, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 3 * 60_000);

    let afterMgr49Calls = 0;

    renderManagers((url, init) => {
      if (url.endsWith('/journal/stream')) return sseRoute(invalidateTrigger, init);
      if (!url.includes('/managers')) return undefined;
      const afterId = afterIdOf(url);
      if (afterId === 'mgr-49') {
        afterMgr49Calls += 1;
        if (afterMgr49Calls === 1) return json({ managers: pageA });
        return r1Gate.promise.then(() => json({ managers: pageARefreshed }));
      }
      if (afterId === 'a-49') {
        return json({ managers: pageC });
      }
      if (afterId === null) return json({ managers: firstPage(MANAGERS_PAGE) });
      return json({ managers: [] });
    });

    await waitForFirstPage();

    fireEvent.click(buttonByText(/^もっと見る（いま \d+ 件）$/));
    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`);
    });

    invalidateTrigger.resolve();
    await waitFor(() => {
      expect(afterMgr49Calls).toBe(2);
    });

    fireEvent.click(buttonByText(/^もっと見る（いま \d+ 件）$/));
    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 3} 件）`);
    });

    r1Gate.resolve();

    await waitFor(() => {
      expect(
        screen.getByText(
          `もっと見る（いま ${MANAGERS_PAGE + (MANAGERS_PAGE - 1) + MANAGERS_PAGE} 件）`,
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
  });
});
