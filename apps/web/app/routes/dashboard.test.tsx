// @vitest-environment jsdom
/**
 * ダッシュボードの「今日の利用」カードが、`/usage` 画面・CLI と同じ嘘をつかない
 * 規約を守っていること（`apps/cli/src/usage.ts` の docstring と同じ規約）。
 */
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

import Dashboard from './dashboard';

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

function renderDashboard(usageBody: {
  rows: unknown[];
  since: string | null;
  beforeLedger: boolean;
  notice?: string;
}) {
  stubFetch((url) => {
    if (url.includes('/journal/stream')) {
      return sse([{ event: 'open', data: { ok: true } }], { keepOpen: true });
    }
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
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
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
