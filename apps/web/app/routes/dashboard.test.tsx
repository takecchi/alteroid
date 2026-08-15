// @vitest-environment jsdom
/**
 * ダッシュボードについて2つ。
 *
 * 1. 「今日の利用」カードが、`/usage` 画面・CLI と同じ嘘をつかない規約を守っていること
 *    （`apps/cli/src/usage.ts` の docstring と同じ規約）
 * 2. 日誌を `AuthedShell` の購読から context 越しに受け取り、**自分では SSE を張らない**こと
 */
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JournalFeedProvider } from '~/hooks/journal-feed';
import { summarizeJournalEntry } from '~/hooks/queries';
import type { JournalLive } from '~/hooks/use-journal-live';
import type { JournalEntry } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl, type FetchStub } from '~/test-support';

import Dashboard from './dashboard';

const RECENT: JournalEntry = {
  type: 'decision',
  id: 'recent-decision',
  at: '2026-08-14T09:00:00.000Z',
  decision: 'たった今届いた判断',
  grounds: '記憶',
};

const EMPTY_FEED: JournalLive = { status: 'live', recent: [] };

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

function renderDashboard(
  usageBody: {
    rows: unknown[];
    since: string | null;
    beforeLedger: boolean;
    notice?: string;
  },
  live: JournalLive = EMPTY_FEED,
): FetchStub {
  // **`/journal/stream` の経路を置いていない。** 置くと購読が増えたことに気づけない
  // （知らない URL は `stubFetch` が「繋がらない」にするので、張りに行けば必ず出る）。
  const stub = stubFetch((url) => {
    if (url.includes('/reports')) return json({ reports: [] });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.includes('/managers')) return json({ managers: [] });
    if (url.includes('/schedule')) return json({ entries: [] });
    if (url.includes('/usage')) {
      return json({
        ...usageBody,
        notice: usageBody.notice ?? USAGE_ESTIMATE_NOTICE,
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
      <JournalFeedProvider value={live}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
  return stub;
}

describe('ダッシュボードの「今日の利用」', () => {
  it('台帳がまだ空（since が null）なら $0.00 と言わない', async () => {
    renderDashboard({ rows: [], since: null, beforeLedger: false });

    expect(await screen.findByText('まだ記録が無い。')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('beforeLedger が真なら 0 ではなく記録が無いと言う', async () => {
    renderDashboard({ rows: [], since: '2026-08-01T00:00:00.000Z', beforeLedger: true });

    expect(await screen.findByText(/今日の分はまだ記録が無い/)).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('金額が出ているときは但し書きも一緒に出す', async () => {
    renderDashboard({
      rows: [
        {
          date: '2026-08-14',
          managerId: 'm1',
          model: 'claude-opus-4',
          updatedAt: '2026-08-14T10:00:00.000Z',
          totals: { ...ZERO_USAGE, costUsd: 0.02 },
        },
      ],
      since: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
    });

    expect(await screen.findByText('$0.0200')).toBeTruthy();
    expect(screen.getByText(USAGE_ESTIMATE_NOTICE)).toBeTruthy();
  });
});

describe('日誌は AuthedShell の購読から受け取る', () => {
  const USAGE = { rows: [], since: null, beforeLedger: false };

  it('context の recent をそのまま出す', async () => {
    renderDashboard(USAGE, { status: 'live', recent: [RECENT] });

    expect(await screen.findByText(summarizeJournalEntry(RECENT))).toBeTruthy();
  });

  it('自分では SSE を張らない（購読は AuthedShell の1本だけ）', async () => {
    const stub = renderDashboard(USAGE, { status: 'live', recent: [RECENT] });

    // 画面が出揃うまで待ってから見る（描画前に数えると、張っていても空になる）。
    await screen.findByText(summarizeJournalEntry(RECENT));
    expect(stub.calls.filter((url) => url.includes('/journal/stream'))).toEqual([]);
  });
});
