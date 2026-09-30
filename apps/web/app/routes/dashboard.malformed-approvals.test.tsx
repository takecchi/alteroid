// @vitest-environment jsdom
/**
 * `GET /approvals` の応答が `approvals` の配列を持たない形のとき（版のずれ）のダッシュボード（issue #2308）。
 *
 * 測る保証は2つ — (1) ダッシュボードが落ちない（ErrorBoundary に捕まらず、他のカードも出る）
 * (2) 「承認待ち」カードは 0件（「なし。」）ではなく「読めていない」の表示になる。
 * 型は `approvals` を配列と言っているので、ここが守るのは実行時の倒れ先だけである。
 */
import { USAGE_ESTIMATE_NOTICE } from '@alteroid/core/usage';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JournalFeedProvider } from '@alteroid/swr';
import type { JournalLive } from '@alteroid/swr';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Dashboard from './dashboard';

// TZ の固定は `dashboard.test.tsx` の冒頭と同じ形（`vi.hoisted` でなければ静かに効かない）。
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

const EMPTY_FEED: JournalLive = { status: 'live', recent: [], receivedCount: 0 };

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

function renderDashboard(approvalsBody: unknown) {
  stubFetch((url) => {
    if (url.includes('/reports')) return json({ reports: [] });
    if (url.includes('/approvals')) return json(approvalsBody);
    if (url.includes('/managers')) return json({ managers: [] });
    if (url.includes('/schedule')) return json({ entries: [] });
    if (url.includes('/usage')) {
      return json({
        rows: [],
        since: null,
        beforeLedger: false,
        today: '2026-08-14',
        notice: USAGE_ESTIMATE_NOTICE,
        turnRows: [],
        breakdown: null,
      });
    }
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/', Component: Dashboard }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <JournalFeedProvider value={EMPTY_FEED}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
}

const MALFORMED: [string, unknown][] = [
  ['空のオブジェクト', {}],
  ['approvals が null', { approvals: null }],
  ['approvals が配列でない', { approvals: 'x' }],
  ['本体が null', null],
];

describe('/approvals の応答が配列を持たない形のとき', () => {
  it.each(MALFORMED)(
    '%s でも落ちず、承認待ちカードは0件でなく「読めていない」になる',
    async (_n, body) => {
      renderDashboard(body);

      // (2) 「読めていない」の表示（エラーのときと同じ `role="alert"`）
      const note = await screen.findByText(/承認待ちを読めていない/);
      // (1) 落ちていない（React Router 既定の ErrorBoundary に代わっていない）
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
      expect(screen.getByText('稼働中のマネージャー')).toBeTruthy();
      // カードは承認待ちのもので、0件の表示も「答える」リンクも出ていない
      // 範囲が取れなければここで落とす（別の要素の中を見て緑になるのを防ぐ）。
      const card = note.closest<HTMLElement>('[data-slot="card"]');
      expect(card).not.toBeNull();
      expect(within(card!).getByText('承認待ち')).toBeTruthy();
      expect(within(card!).queryByText('なし。')).toBeNull();
      expect(within(card!).queryByText('答える')).toBeNull();
    },
  );

  it('真っ当な空配列は今までどおり「なし。」（読めていないにはしない）', async () => {
    renderDashboard({ approvals: [] });

    expect(await screen.findByText('なし。')).toBeTruthy();
    expect(screen.queryByText(/承認待ちを読めていない/)).toBeNull();
  });
});
