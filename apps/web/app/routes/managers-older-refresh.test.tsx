// @vitest-environment jsdom
/**
 * 受け入れ基準（issue #1624）: 「もっと見る」で読み足した行
 * （`useManagersWindow` の頁2以降）も、SSE で届く生きた更新
 * （`use-journal-live.ts` の `invalidate()`）で取り直されること。
 *
 * **直す前の main での症状**: `invalidate()` は
 * `mutate((key) => isKeyOfType(key, 'managers'))` で `KEY.managers(query)`
 * （＝先頭の頁、SWR のキャッシュに載っている分）だけを取り直していた。
 * `older`（`use-managers-window.ts`）は SWR の外に置いたただの `useState`
 * で、`loadOlder()` を手で呼んだとき以外に書き換わる経路が無かった。
 *
 * 一覧は `startedAt` 降順・先頭固定 `MANAGERS_PAGE` 件が「頁1」なので、
 * 「もっと見る」で読み足した行（頁2以降）は最新の頁1には二度と現れない
 * ——頁1の再取得だけでは絶対に更新されない。しかも頁2が `MANAGERS_PAGE`
 * に届かなければ「もっと見る」のボタン自体が消える（終端）ので、
 * フィルタを変えて `key` を作り直す（画面を離れて戻る）以外に更新する
 * 手が無かった。
 *
 * 筋書き: 一覧を開いたまま、頁2の委譲の状態が running → lost に変わる。
 * SSE で `exchange(with: manager)` が届き、画面は「生きている」ように
 * 見えるが、直す前は頁2の行の札が running のまま止まっていた。
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

describe('もっと見るで読み足した行も SSE の生きた更新に追随する（#1624）', () => {
  it('頁2の委譲が running→lost になったら、SSE 後にその行も lost 表示になる', async () => {
    // 頁2（`mgr-50`）の状態は可変にしておき、「サーバ側では変わった」を模す。
    let page2Status: ManagerSummary['status'] = 'running';
    let page2Live = true;

    let resolveTrigger: () => void = () => undefined;
    const triggerAfterLoadOlder = new Promise<void>((resolve) => {
      resolveTrigger = resolve;
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
                text: 'マネージャーからの発言',
              },
              after: triggerAfterLoadOlder,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (!url.includes('/managers')) return undefined;
      if (url.includes('afterId=')) {
        return json({
          managers: [
            {
              ...BASE,
              managerId: `mgr-${MANAGERS_PAGE}`,
              request: `req-mgr-${MANAGERS_PAGE}`,
              status: page2Status,
              live: page2Live,
              startedAt: new Date(
                Date.UTC(2026, 7, 16, 3, 0, 0) - MANAGERS_PAGE * 60_000,
              ).toISOString(),
            },
          ],
        });
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

    // 「もっと見る」で頁2（mgr-50、running）を読み足す。
    fireEvent.click(screen.getByRole('button', { name: /もっと見る/ }));
    await waitFor(() => {
      expect(row().getByText(`req-mgr-${MANAGERS_PAGE}`)).toBeTruthy();
    });
    // この時点で頁2の行は「実行中」の札を持つ。
    const page2Row = row().getByText(`req-mgr-${MANAGERS_PAGE}`).closest('li');
    expect(page2Row).not.toBeNull();
    expect(within(page2Row as HTMLElement).getByText('実行中')).toBeTruthy();

    const afterIdCallsBefore = stub.calls.filter((url) => url.includes('afterId=')).length;
    expect(afterIdCallsBefore).toBe(1);

    // サーバ側では mgr-50 が running → lost になった、という想定。
    page2Status = 'lost';
    page2Live = false;

    // SSE で「マネージャーからの発言が届いた」を通知する
    // （`use-journal-live.ts` の `invalidate()` は `exchange(with:'manager')` で
    // `KEY.managers` を束で invalidate する——一覧が生きていることの本来の
    // 合図）。
    resolveTrigger();

    // 頁1（先頭50件）は再取得されるはずなので、それを合図に十分待つ。
    await waitFor(() => {
      expect(stub.calls.filter((url) => url.includes('/managers') && !url.includes('afterId=')).length).toBeGreaterThan(1);
    });

    // **求める挙動（#1624 の受け入れ基準）**: 一覧が「生きている」と言える
    // なら、SSE で届いた更新の合図は、頁1だけでなく既に読み足した頁2の行
    // にも及ぶ——さもなければ「もっと見る」を押した瞬間の値が、画面を開いた
    // ままの間ずっと凍りつく（`ManagersOlderStatus === 'end'` になった後は
    // ボタン自体が消えるので、フィルタを変える＝`key` を作り直す以外に
    // 更新する手すら無い）。
    //
    // ⛔ 直す前の main ではここから両方とも赤くなる——`useManagersWindow` の
    // `older` state は SWR の外にあり、`use-journal-live.ts` の
    // `invalidate()` が落とすのは `KEY.managers(query)`（頁1）だけだった
    // ためである（`use-managers-window.ts` の doc、`use-journal-live.ts` の
    // `invalidate()` を参照）。
    await waitFor(() => {
      const afterIdCallsAfter = stub.calls.filter((url) => url.includes('afterId=')).length;
      expect(afterIdCallsAfter).toBeGreaterThan(afterIdCallsBefore);
    });

    await waitFor(() => {
      const page2RowAfter = row().getByText(`req-mgr-${MANAGERS_PAGE}`).closest('li');
      expect(page2RowAfter).not.toBeNull();
      expect(within(page2RowAfter as HTMLElement).getByText('セッションへ戻れず')).toBeTruthy();
    });
  });
});
