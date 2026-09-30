// @vitest-environment jsdom
/**
 * ダッシュボードの「承認待ち」「稼働中のマネージャー」が、読み込み中に空の文言を出さないこと
 * （issue #2325）。
 *
 * まだ一度も取れていない（`data` も `error` も無い）間に「なし。」「いま走っているものはない。」を
 * 描くと、取れた結果が0件だったように読める。失敗（`error`）は従来どおり `ErrorNote` が先に拾う。
 */
import { USAGE_ESTIMATE_NOTICE } from '@alteroid/core/usage';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * `held` に挙げた経路は解決しない Promise で保留する（読み込み中のまま止める）。
 * それ以外は0件で成功させる。
 */
function renderDashboard(held: { approvals?: boolean; managers?: boolean }) {
  stubFetch((url) => {
    if (url.includes('/reports')) return json({ reports: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
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
  const stubbed = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (
      (held.approvals === true && url.includes('/approvals')) ||
      (held.managers === true && url.includes('/managers'))
    ) {
      return new Promise<Response>(() => {});
    }
    return stubbed(input, init);
  }) as typeof fetch;

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

function cardOf(title: string): HTMLElement {
  const card = screen.getByText(title).closest<HTMLElement>('[data-slot="card"]');
  if (card === null) throw new Error(`カードが見つからない: ${title}`);
  return card;
}

describe('ダッシュボードの読み込み中', () => {
  it('承認待ちの応答が保留のあいだは「なし。」を出さない', async () => {
    renderDashboard({ approvals: true });

    // 他のカードが取れ終わるまで待つ（保留の側だけが読み込み中のまま残る）。
    expect(await screen.findByText('まだ何も届いていない。')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('いま走っているものはない。')).not.toBeNull());

    const card = cardOf('承認待ち');
    expect(within(card).queryByText('なし。')).toBeNull();
    expect(within(card).getByText('読み込み中')).toBeTruthy();
  });

  it('走っているカードの応答が保留のあいだは「いま走っているものはない。」を出さない', async () => {
    renderDashboard({ managers: true });

    expect(await screen.findByText('なし。')).toBeTruthy();

    const card = cardOf('稼働中のマネージャー');
    expect(within(card).queryByText('いま走っているものはない。')).toBeNull();
    expect(within(card).getByText('読み込み中')).toBeTruthy();
  });

  it('対照: 0件で成功したら、どちらの文言も出る', async () => {
    renderDashboard({});

    expect(await screen.findByText('なし。')).toBeTruthy();
    expect(await screen.findByText('いま走っているものはない。')).toBeTruthy();
  });
});
