// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive, MANAGERS_PAGE } from '@alteroid/swr';
import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Managers from './managers';

// waitFor で繰り返す条件を getByText で見ない: 100 行で1回 10ms 超となり、繰り返しごとに払うと混んだ時にテストの枠を食うため
function pageText(): string {
  return document.body.textContent ?? '';
}

// getByRole('button', { name }) にしない: ロール照会は全要素の役割・可視性を計算し、100 行を描いた画面では1回が数十 ms かかるため
function moreButton(): HTMLButtonElement {
  const button = screen.getByText(/^もっと見る（いま \d+ 件）$/).closest('button');
  if (button === null) throw new Error('「もっと見る」がボタンとして描かれていない');
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

function makeInvalidateTrigger(): { after: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const after = new Promise<void>((r) => {
    resolve = r;
  });
  return { after, resolve };
}

function sseRoute(trigger: { after: Promise<void> }, init: RequestInit | undefined) {
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
        after: trigger.after,
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

describe('背景の取り直しが最後の頁の件数を変えたら olderStatus を追随させる（issue #1998）', () => {
  it('50件→49件に変わる取り直しで olderStatus が end になる（もっと見るボタンが消える）', async () => {
    let olderCount = MANAGERS_PAGE;
    const trigger = makeInvalidateTrigger();

    renderManagers((url, init) => {
      if (url.endsWith('/journal/stream')) return sseRoute(trigger, init);
      if (!url.includes('/managers')) return undefined;
      const afterId = afterIdOf(url);
      if (afterId === 'mgr-49') {
        return json({
          managers: olderPage('old', olderCount, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000),
        });
      }
      if (afterId === null) return json({ managers: firstPage(MANAGERS_PAGE) });
      return json({ managers: [] });
    });

    await waitForFirstPage();

    fireEvent.click(moreButton());
    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`);
    });

    olderCount = MANAGERS_PAGE - 1;
    trigger.resolve();

    await waitFor(() => {
      expect(pageText()).toContain(`これより古い委譲は無い（全 ${MANAGERS_PAGE * 2 - 1} 件）。`);
    });
    expect(screen.queryByText(/^もっと見る（いま/)).toBeNull();
  });

  it('49件→50件に変わる取り直しで olderStatus が progress に戻る（もっと見るボタンが出る）', async () => {
    let olderCount = MANAGERS_PAGE - 1;
    const trigger = makeInvalidateTrigger();

    renderManagers((url, init) => {
      if (url.endsWith('/journal/stream')) return sseRoute(trigger, init);
      if (!url.includes('/managers')) return undefined;
      const afterId = afterIdOf(url);
      if (afterId === 'mgr-49') {
        return json({
          managers: olderPage('old', olderCount, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000),
        });
      }
      if (afterId === null) return json({ managers: firstPage(MANAGERS_PAGE) });
      return json({ managers: [] });
    });

    await waitForFirstPage();

    fireEvent.click(moreButton());
    await waitFor(() => {
      expect(pageText()).toContain(`これより古い委譲は無い（全 ${MANAGERS_PAGE * 2 - 1} 件）。`);
    });
    expect(screen.queryByText(/^もっと見る（いま/)).toBeNull();

    olderCount = MANAGERS_PAGE;
    trigger.resolve();

    await waitFor(() => {
      expect(moreButton().textContent).toBe(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`);
    });
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
  });

  it('最後以外（頁1個目）の取り直しの件数変化は olderStatus を動かさない', async () => {
    const trigger = makeInvalidateTrigger();
    const pageAInitial = olderPage('a', MANAGERS_PAGE, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000);
    const pageARefreshed = olderPage('a2', 5, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000);
    const pageBTime = PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 2 * 60_000;

    let refreshHappened = false;

    renderManagers((url, init) => {
      if (url.endsWith('/journal/stream')) return sseRoute(trigger, init);
      if (!url.includes('/managers')) return undefined;
      const afterId = afterIdOf(url);
      if (afterId === 'mgr-49') {
        return json({ managers: refreshHappened ? pageARefreshed : pageAInitial });
      }
      if (afterId === 'a-49') {
        return json({ managers: olderPage('b', MANAGERS_PAGE, pageBTime) });
      }
      if (afterId === null) return json({ managers: firstPage(MANAGERS_PAGE) });
      return json({ managers: [] });
    });

    await waitForFirstPage();

    fireEvent.click(moreButton());
    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`);
    });

    fireEvent.click(moreButton());
    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 3} 件）`);
    });

    refreshHappened = true;
    trigger.resolve();

    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE + 5 + MANAGERS_PAGE} 件）`);
    });
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
    expect(moreButton()).toBeTruthy();
  });

  it('最後の頁の取り直しが失敗したら olderStatus は前回の値のまま動かさない', async () => {
    const trigger = makeInvalidateTrigger();
    let shouldFail = false;

    const stub = renderManagers((url, init) => {
      if (url.endsWith('/journal/stream')) return sseRoute(trigger, init);
      if (!url.includes('/managers')) return undefined;
      const afterId = afterIdOf(url);
      if (afterId === 'mgr-49') {
        if (shouldFail) return json({ error: 'boom' }, 500);
        return json({
          managers: olderPage('old', MANAGERS_PAGE, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000),
        });
      }
      if (afterId === null) return json({ managers: firstPage(MANAGERS_PAGE) });
      return json({ managers: [] });
    });

    await waitForFirstPage();

    fireEvent.click(moreButton());
    await waitFor(() => {
      expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`);
    });

    const afterIdCallsBefore = stub.calls.filter((url) => afterIdOf(url) === 'mgr-49').length;

    shouldFail = true;
    trigger.resolve();

    await waitFor(() => {
      const afterIdCallsAfter = stub.calls.filter((url) => afterIdOf(url) === 'mgr-49').length;
      expect(afterIdCallsAfter).toBeGreaterThan(afterIdCallsBefore);
    });

    expect(pageText()).toContain(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`);
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
  });
});
