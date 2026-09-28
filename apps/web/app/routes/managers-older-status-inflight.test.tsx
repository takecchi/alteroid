// @vitest-environment jsdom
/**
 * 受け入れ基準（issue #1998、並行性の線引き）: `runOlderRefresh` が最後の頁を
 * 取り直せても、PR #1629 が避けたかった `loadOlder()` との競合を持ち込む形の
 * ときは `lastOlderCount` を更新しないこと。条件は2つ、どちらか一方でも
 * 成り立てば更新しない——
 *
 * 1. `loadOlder()` が走っている間（応答がまだ届いていない）。
 * 2. 取り直しの応答が届くまでに頁が足された（最後の頁の錨が変わった）。
 *
 * 単純な形（並行性の無い、最後の頁がそのまま取り直る/失敗する）は
 * `managers-older-status.test.tsx` を見よ。
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
    expect(row().getByText('req-mgr-0')).toBeTruthy();
  });
}

describe('runOlderRefresh は loadOlder() との競合を持ち込まない（issue #1998）', () => {
  it('loadOlder() が走っている間に届いた取り直しの結果では olderStatus を動かさない', async () => {
    const invalidateTrigger = makeGate();
    // 頁A（錨 mgr-49）の背景の取り直し（R1）の応答を保留する門。
    const r1Gate = makeGate();
    // 2回目の「もっと見る」（`loadOlder()`、錨 mgr-99＝頁Aの最後の行）の
    // 応答を保留する門。
    const loadOlderGate = makeGate();

    const pageA = olderPage('a', MANAGERS_PAGE, PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000);
    // R1 は頁Aの件数が 49 件に変わったと応答する——**もし `loadOlder()` との
    // 競合を無視して素通しに適用すれば** olderStatus は `end` になる。
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
        // 2回目以降＝背景の取り直し（R1）。保留する。
        return r1Gate.promise.then(() => json({ managers: pageARefreshed }));
      }
      if (afterId === 'a-49') {
        // `loadOlder()` の2回目クリック分。保留する。
        return loadOlderGate.promise.then(() => json({ managers: pageC }));
      }
      if (afterId === null) return json({ managers: firstPage(MANAGERS_PAGE) });
      return json({ managers: [] });
    });

    await waitForFirstPage();

    // 1回目の「もっと見る」— 頁A（50件、progress）。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`)).toBeTruthy();
    });

    // SSE → 頁1の再検証が終わり、背景の取り直し R1（頁Aの再取得）が始まる。
    // R1 は保留のまま。
    invalidateTrigger.resolve();
    await waitFor(() => {
      expect(afterMgr49Calls).toBe(2);
    });

    // R1 が保留のうちに、2回目の「もっと見る」を押す
    // （`isLoadingOlder` はまだ false なのでボタンは押せる）。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /読み込み中/ })).toBeTruthy();
    });

    // R1 の応答を返す——頁Aが 49 件になったという内容。
    // **`loadOlder()` がまだ走っている（`読み込み中…`）ので、この件数は
    // `lastOlderCount` へ反映されてはいけない。**
    r1Gate.resolve();

    // 少し待っても、`これより古い委譲は無い`（olderStatus === 'end'）には
    // ならないこと。ボタンは「読み込み中…」のままのはず。
    await waitFor(() => {
      expect(stub.calls.some((u) => afterIdOf(u) === 'mgr-49')).toBe(true);
    });
    expect(screen.queryByText(/これより古い委譲は無い/)).toBeNull();
    expect(screen.getByRole('button', { name: /読み込み中/ })).toBeTruthy();

    // `loadOlder()` の応答を返す——頁C、50件。これは明示の呼び出しなので
    // `lastOlderCount` を権威的に上書きしてよい。
    loadOlderGate.resolve();

    await waitFor(() => {
      // 合計 = 頁1(50) + 頁A（R1で49件に更新された内容）(49) + 頁C(50) = 149
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
    // R1（頁Aの取り直し）は 49 件だったと応答する——もし錨の変化を見ずに
    // 「最後の頁の結果」として素通しに適用すれば、頁Aはもう最後の頁ではない
    // のに olderStatus を動かしてしまう。
    const pageARefreshed = olderPage(
      'a2',
      MANAGERS_PAGE - 1,
      PAGE1_ANCHOR_TIME - MANAGERS_PAGE * 60_000,
    );
    // 頁C（2回目の「もっと見る」、錨 a-49＝頁Aの最後の行）は即座に50件で
    // 応答が返る——R1 が保留のうちに `loadOlder()` は完了する。
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

    // 1回目の「もっと見る」— 頁A（50件、progress）。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 2} 件）`)).toBeTruthy();
    });

    // SSE → 頁1の再検証が終わり、背景の取り直し R1（頁Aの再取得）が始まる。
    // R1 は保留のまま。
    invalidateTrigger.resolve();
    await waitFor(() => {
      expect(afterMgr49Calls).toBe(2);
    });

    // R1 が保留のうちに、2回目の「もっと見る」を押す——`loadOlder()` は
    // 即座に完了し、頁C（錨 a-49）が足される。この時点で `isLoadingOlder`
    // は false に戻っている（R1 が保留であることとは無関係）。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      // 合計 = 頁1(50) + 頁A(50) + 頁C(50) = 150
      expect(screen.getByText(`もっと見る（いま ${MANAGERS_PAGE * 3} 件）`)).toBeTruthy();
    });

    // ここで R1 の応答を返す——頁Aはもう「最後の頁」ではない
    // （頁Cが足された後なので、頁Aの錨は取り直しを始めた時点から変わった
    // ……正確には「最後の頁」という位置が頁Aから頁Cへ移った）。
    r1Gate.resolve();

    // 少し待っても、頁Aの49件という結果に引きずられて olderStatus が
    // `end` になったりボタンの合計件数が動いたりしないこと
    // （頁Aの中身自体は取り直しで反映されてよいので、合計は 149 になる——
    // 50 + 49 + 50——が、判定は `progress` のまま）。
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
