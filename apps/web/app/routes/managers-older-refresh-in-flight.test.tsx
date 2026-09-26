// @vitest-environment jsdom
/**
 * 受け入れ基準（issue #1624 のレビュー指摘）: 読み足した頁の背景の取り直し
 * （`use-managers-window.ts` の `refreshOlderPages`）が走っている間にもう一度
 * 頁1の再検証が終わっても、その分の変化を取りこぼさないこと。
 *
 * **直す前に在った穴。** 背景の取り直し（`R1`）が走っている間に頁1の
 * 再検証がもう一度終わると、`isRefreshingOlderRef` が真なので
 * `refreshOlderPages()` は即座に `return` していた——「次の頁1の再検証が
 * 来ればそこで追いつく」という当時の doc の前提が、*次が来ない限り*成り
 * 立たない。`R1` の応答がサーバ側では次の変化より前に確定していた場合、
 * `R1` が返ってきても中身は古いままで、そのあと SSE が来なければ読み足した
 * 行はその古い値のまま残り続ける。
 *
 * 筋書き:
 * 1. 「もっと見る」で頁2（mgr-50、running）を読み足す。
 * 2. SSE① で頁1の再検証が終わり、背景の取り直し `R1`（afterId= の2本目）が
 *    始まる——**この応答をまだ返さない**（サーバ側では旧い値のまま確定した
 *    ことにする）。
 * 3. `R1` がまだ保留のうちに、サーバ側では mgr-50 が running → lost になり、
 *    SSE② が届いて頁1の再検証がもう一度終わる。
 * 4. ここで `R1` の応答を返す（旧い値＝running のまま）。
 * 5. **求める挙動**: `R1` が終わった時点で「②のぶんの取り直しがまだ済んで
 *    いない」という積み残しを消費して、もう1回だけ（`R2`）取り直しが走り、
 *    今度は lost を拾って画面に出る。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive } from '~/hooks/use-journal-live';
import { MANAGERS_PAGE } from '~/hooks/use-managers-window';
import type { ManagerSummary } from '~/lib/types';
import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

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

/** `startedAt` の降順（デーモンの契約）で N 件。頁1に相当する。 */
function firstPage(count: number): ManagerSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    managerId: `mgr-${index}`,
    request: `req-mgr-${index}`,
    status: 'running',
    startedAt: new Date(Date.UTC(2026, 7, 16, 3, 0, 0) - index * 60_000).toISOString(),
  }));
}

/** 頁2（mgr-50。1件）の応答本文。呼び出し時点の `status`/`live` をそのまま使う。 */
function page2Body(status: ManagerSummary['status'], live: boolean) {
  return {
    managers: [
      {
        ...BASE,
        managerId: `mgr-${MANAGERS_PAGE}`,
        request: `req-mgr-${MANAGERS_PAGE}`,
        status,
        live,
        startedAt: new Date(Date.UTC(2026, 7, 16, 3, 0, 0) - MANAGERS_PAGE * 60_000).toISOString(),
      },
    ],
  };
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

describe('背景の取り直しが走っている間の分は取りこぼさない（issue #1624 のレビュー指摘）', () => {
  it('R1 が保留の間に届いた②のぶんも、R1 が終わったら追い撃ち（R2）で拾う', async () => {
    let page2Status: ManagerSummary['status'] = 'running';
    let page2Live = true;

    let resolveTrigger1: () => void = () => undefined;
    const trigger1 = new Promise<void>((resolve) => {
      resolveTrigger1 = resolve;
    });
    let resolveTrigger2: () => void = () => undefined;
    const trigger2 = new Promise<void>((resolve) => {
      resolveTrigger2 = resolve;
    });

    // **`R1`（afterId= の2本目）だけ応答を保留する。** 本文はこの関数が
    // 呼ばれた瞬間（＝②で `page2Status` が書き換わる前）に凍結する——
    // 「サーバ側では②の変化より前に確定していた」を模す。届けるタイミング
    // だけを `resolveR1()` で後から決める。
    let afterIdCallCount = 0;
    let resolveR1: (() => void) | undefined;
    const r1Gate = new Promise<void>((resolve) => {
      resolveR1 = resolve;
    });

    const stub = stubFetch((url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'e1',
                at: '2026-08-16T04:00:00.000Z',
                with: 'manager',
                role: 'inbound',
                text: 'マネージャーからの発言 その1',
              },
              after: trigger1,
            },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'e2',
                at: '2026-08-16T04:05:00.000Z',
                with: 'manager',
                role: 'inbound',
                text: 'マネージャーからの発言 その2',
              },
              after: trigger2,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (!url.includes('/managers')) return undefined;
      if (url.includes('afterId=')) {
        afterIdCallCount += 1;
        if (afterIdCallCount === 2) {
          // 本文はいま（②より前）の値で固定し、届くのは `resolveR1()` の後。
          const frozen = json(page2Body(page2Status, page2Live));
          return r1Gate.then(() => frozen);
        }
        return json(page2Body(page2Status, page2Live));
      }
      return json({ managers: firstPage(MANAGERS_PAGE) });
    });

    const router = createMemoryRouter([{ path: '/', Component: Managers }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <Sentinel />
        <RouterProvider router={router} />
      </Providers>,
    );

    // 頁1が出る。
    await waitFor(() => {
      expect(row().getByText('req-mgr-0')).toBeTruthy();
    });

    // 「もっと見る」で頁2（mgr-50、running）を読み足す（afterId= の1本目）。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(row().getByText(`req-mgr-${MANAGERS_PAGE}`)).toBeTruthy();
    });
    expect(afterIdCallCount).toBe(1);

    // SSE① → 頁1の再検証が終わり、背景の取り直し R1（afterId= の2本目）が
    // 始まる。R1 はまだ保留のまま。
    resolveTrigger1();
    await waitFor(() => {
      expect(
        stub.calls.filter((url) => url.includes('/managers') && !url.includes('afterId=')).length,
      ).toBeGreaterThan(1);
    });
    await waitFor(() => {
      expect(afterIdCallCount).toBe(2);
    });

    // R1 が保留のうちに、サーバ側で mgr-50 が running → lost になる。
    page2Status = 'lost';
    page2Live = false;

    // SSE② → 頁1の再検証がもう一度終わる。R1 はまだ保留なので、この分の
    // 取り直しは「積み残し」として覚えておくだけのはず（即座に3本目は
    // 撃たれない）。
    resolveTrigger2();
    await waitFor(() => {
      expect(
        stub.calls.filter((url) => url.includes('/managers') && !url.includes('afterId=')).length,
      ).toBeGreaterThan(2);
    });

    // R1 の応答を返す（本文は②より前の running のまま）。
    resolveR1?.();

    // **求める挙動**: R1 が終わった時点で積み残しを消費し、もう1回だけ
    // （R2、afterId= の3本目）取り直しが走って lost を拾う。
    //
    // ⛔ 直す前は、R1 が終わった時点で `isRefreshingOlderRef` を素通しに
    // 戻すだけで積み残しの記録が無く、SSE がこれ以上届かないこのテストでは
    // R2 が永遠に撃たれない（`afterIdCallCount` は 2 のまま、行も
    // 「実行中」のまま）。
    await waitFor(() => {
      expect(afterIdCallCount).toBeGreaterThan(2);
    });

    await waitFor(() => {
      const page2RowAfter = row().getByText(`req-mgr-${MANAGERS_PAGE}`).closest('li');
      expect(page2RowAfter).not.toBeNull();
      expect(within(page2RowAfter as HTMLElement).getByText('セッションへ戻れず')).toBeTruthy();
    });
  });
});
