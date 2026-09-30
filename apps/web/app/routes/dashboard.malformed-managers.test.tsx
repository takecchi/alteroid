// @vitest-environment jsdom
/**
 * `GET /managers` の応答が `managers` の配列を持たない形のとき（版のずれ）のダッシュボード（issue #2389）。
 *
 * 測る保証は2つ — (1) ダッシュボードが落ちない（ErrorBoundary に捕まらず、他のカードも出る）
 * (2) 「稼働中のマネージャー」カードは 0件（「いま走っているものはない。」）ではなく
 * 「読めていない」の表示になる。型は `managers` を配列と言っているので、ここが守るのは
 * 実行時の倒れ先だけである。承認待ち側は `dashboard.malformed-approvals.test.tsx`。
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

function renderDashboard(managersBody: unknown, opts: { hold?: boolean } = {}) {
  stubFetch((url) => {
    if (url.includes('/reports')) return json({ reports: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/managers')) return json(managersBody);
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
  if (opts.hold === true) {
    // `/managers` だけ解決しない Promise で保留する（読み込み中のまま止める）。
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/managers')) return new Promise<Response>(() => {});
      return stubbed(input, init);
    }) as typeof fetch;
  }
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
  ['managers が null', { managers: null }],
  ['managers が配列でないオブジェクト', { managers: {} }],
  ['managers の鍵が無い', {}],
];

describe('/managers の応答が配列を持たない形のとき', () => {
  it.each(MALFORMED)(
    '%s でも落ちず、稼働中カードは0件でなく「読めていない」になる',
    async (_n, body) => {
      renderDashboard(body);

      // (2) 「読めていない」の表示（エラーのときと同じ `role="alert"`）
      const note = await screen.findByText(/稼働中のマネージャーを読めていない/);
      // (1) 落ちていない（React Router 既定の ErrorBoundary に代わっていない）
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
      expect(screen.getByText('承認待ち')).toBeTruthy();
      // カードは稼働中のもので、0件の表示も読み込み中も出ていない。
      // 範囲が取れなければここで落とす（別の要素の中を見て緑になるのを防ぐ）。
      const card = note.closest<HTMLElement>('[data-slot="card"]');
      expect(card).not.toBeNull();
      expect(within(card!).getByText('稼働中のマネージャー')).toBeTruthy();
      expect(within(card!).queryByText('いま走っているものはない。')).toBeNull();
      expect(within(card!).queryByText('読み込み中')).toBeNull();
      expect(screen.queryByText('いま走っているものはない。')).toBeNull();
    },
  );

  it('真っ当な空配列は今までどおり「いま走っているものはない。」（読めていないにはしない）', async () => {
    renderDashboard({ managers: [] });

    expect(await screen.findByText('いま走っているものはない。')).toBeTruthy();
    expect(screen.queryByText(/稼働中のマネージャーを読めていない/)).toBeNull();
  });

  it('読み込み中は Spinner（読めていないにも「走っているものはない」にもしない）', async () => {
    renderDashboard({ managers: [] }, { hold: true });

    // 他のカードが取れ終わるまで待つ（保留の側だけが読み込み中のまま残る）。
    expect(await screen.findByText('なし。')).toBeTruthy();
    const card = screen
      .getByText('稼働中のマネージャー')
      .closest<HTMLElement>('[data-slot="card"]');
    expect(card).not.toBeNull();
    expect(within(card!).getByText('読み込み中')).toBeTruthy();
    expect(within(card!).queryByText('いま走っているものはない。')).toBeNull();
    expect(screen.queryByText(/稼働中のマネージャーを読めていない/)).toBeNull();
  });
});
