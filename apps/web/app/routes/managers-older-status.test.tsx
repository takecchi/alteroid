// @vitest-environment jsdom
/**
 * 受け入れ基準（issue #1998）: 背景の取り直し（`use-managers-window.ts` の
 * `runOlderRefresh`）が「もっと見る」で読み足した**最後の頁**を取り直せたとき、
 * その頁の件数で `lastOlderCount` を更新し、`olderStatus`（「もっと見る」
 * ボタンの有無）に反映すること。
 *
 * **直す前の症状。** `olderStatus` の材料は `lastOlderCount` だけで、
 * `lastOlderCount` を書くのは `loadOlder()` だけだった——PR #1629 が意図して
 * 避けた形（`use-managers-window.ts` の旧 doc「`lastOlderCount` /
 * `olderStatus`（進捗・終端の判定）は動かさない」）。⟹ 背景の取り直しで
 * 最後の頁の件数が変わっても、ボタンの有無は前回の `loadOlder()` の時点の
 * まま残った。特に「最後の頁が `MANAGERS_PAGE` 未満（end）→ 取り直しで
 * `MANAGERS_PAGE` 件」の向きでは、続きがあるのにボタンが消えたままになる
 * （#1998 の「重い」向き）。
 *
 * このファイルは並行性の無い（`loadOlder()` と重ならない）単純な形だけを
 * 見る。`loadOlder()` との競合・頁の追加中の錨変化は
 * `managers-older-status-inflight.test.tsx` を見よ。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '~/hooks/use-journal-live';
import { MANAGERS_PAGE } from '~/hooks/use-managers-window';
import type { ManagerSummary } from '~/lib/types';
import { json, Providers, sse, stubFetch, storeTestBaseUrl, type Route } from '~/test-support';

import Managers from './managers';

function row() {
  return within(screen.getByRole('list'));
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

/** `startedAt` の降順で N 件。頁1に相当する（先頭固定 `MANAGERS_PAGE` 件）。 */
function firstPage(count: number): ManagerSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    managerId: `mgr-${index}`,
    request: `req-mgr-${index}`,
    status: 'running',
    startedAt: new Date(PAGE1_ANCHOR_TIME - index * 60_000).toISOString(),
  }));
}

/** 「もっと見る」で読み足す頁。`prefix` で ID を頁ごとに分ける。 */
function olderPage(prefix: string, count: number, anchorTime: number): ManagerSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    managerId: `${prefix}-${index}`,
    request: `req-${prefix}-${index}`,
    status: 'running',
    startedAt: new Date(anchorTime - index * 60_000).toISOString(),
  }));
}

/** URL から `afterId` を取り出す（部分一致ではなく厳密な query 解析）。 */
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

/** SSE を張りつつ一覧を描く（`shell.tsx` が実機で両方を同時にマウントする形）。 */
function Sentinel() {
  useJournalLive();
  return null;
}

/** SSE で頁1の再検証を1回起こす合図を作る。`with: 'manager'` が
 * `use-journal-live.ts` の `invalidate()` を `managers` の束へ落とす条件。 */
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
    expect(row().getByText('req-mgr-0')).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`)).toBeTruthy();
    });

    // 背景の取り直しでは 49 件に変わる（続きが無くなった、という想定）。
    olderCount = MANAGERS_PAGE - 1;
    trigger.resolve();

    await waitFor(() => {
      expect(
        screen.getByText(`これより古い委譲は無い（全 ${MANAGERS_PAGE * 2 - 1} 件）。`),
      ).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /もっと見る/ })).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(
        screen.getByText(`これより古い委譲は無い（全 ${MANAGERS_PAGE * 2 - 1} 件）。`),
      ).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /もっと見る/ })).toBeNull();

    // 背景の取り直しでは 50 件に戻る（絞り込みに入ってくる委譲が増えた、
    // という想定——#1998 が挙げた「続きがあるのにボタンが消える」向き）。
    olderCount = MANAGERS_PAGE;
    trigger.resolve();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: `もっと見る（いま ${MANAGERS_PAGE * 2} 件）` }),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
  });

  it('最後以外（頁1個目）の取り直しの件数変化は olderStatus を動かさない', async () => {
    const trigger = makeInvalidateTrigger();
    // 頁A（最初の「もっと見る」、錨 mgr-49）は取り直しで 5 件へ激減する。
    // 頁B（2回目の「もっと見る」、錨 a-49 ＝頁Aの最後の行）は取り直しでも
    // MANAGERS_PAGE 件のまま——**最後の頁**なので、olderStatus はこちらだけで
    // 決まるはずである。
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

    // 1回目の「もっと見る」— 頁A。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`)).toBeTruthy();
    });

    // 2回目の「もっと見る」— 頁B（最後の頁になる）。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 3} 件）`)).toBeTruthy();
    });

    // 背景の取り直し——頁A（最後ではない）は 5 件へ激減、頁B（最後）は
    // MANAGERS_PAGE 件のまま。
    refreshHappened = true;
    trigger.resolve();

    // 頁Aの中身自体は取り直しで反映される（件数は 50+5+50=105）。
    await waitFor(() => {
      expect(
        screen.getByText(`もっと見る（いま ${MANAGERS_PAGE + 5 + MANAGERS_PAGE} 件）`),
      ).toBeTruthy();
    });
    // **olderStatus は progress のまま**——頁Aの激減（5 < MANAGERS_PAGE）に
    // 釣られて `end` にならないこと。
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
    expect(screen.getByRole('button', { name: /もっと見る/ })).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`)).toBeTruthy();
    });

    const afterIdCallsBefore = stub.calls.filter((url) => afterIdOf(url) === 'mgr-49').length;

    // 背景の取り直しは失敗する（デーモン側が一時的に 500 を返す、という想定）。
    shouldFail = true;
    trigger.resolve();

    await waitFor(() => {
      const afterIdCallsAfter = stub.calls.filter((url) => afterIdOf(url) === 'mgr-49').length;
      expect(afterIdCallsAfter).toBeGreaterThan(afterIdCallsBefore);
    });

    // **失敗した頁は前回の値のまま**——olderStatus・件数どちらも動かない。
    expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`)).toBeTruthy();
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
  });
});
