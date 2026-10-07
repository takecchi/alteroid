// @vitest-environment jsdom
import { USAGE_ESTIMATE_NOTICE } from '@alteroid/core/usage';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Usage from './usage';

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

function stubUsageCalls(): URL[] {
  const calls: URL[] = [];
  stubFetch((url) => {
    if (url.includes('/managers')) {
      return json({
        managers: [{ managerId: 'mgr-1', request: '調査', startedAt: '2026-08-14T01:00:00.000Z' }],
      });
    }
    if (url.includes('/tokens')) return json({ tokens: [{ id: 'tok-1', label: '個人の鍵' }] });
    if (!url.includes('/usage')) return undefined;
    calls.push(new URL(url));
    return json({
      rows: [],
      since: '2026-08-01T00:00:00.000Z',
      layersSince: '2026-08-01T00:00:00.000Z',
      beforeLedger: false,
      beforeLayers: false,
      notice: USAGE_ESTIMATE_NOTICE,
      breakdown: null,
      unrecordedManagers: [],
      turnRows: [],
    });
  });
  return calls;
}

function renderUsage() {
  const router = createMemoryRouter([{ path: '/', Component: Usage }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('/usage 画面の token 欄（issue #2059）', () => {
  it('token 欄に入れた値が GET /usage の tokenId に載る', async () => {
    const calls = stubUsageCalls();
    renderUsage();

    await screen.findByText(/この期間の使用量の記録はありません/);
    await screen.findByRole('option', { name: '個人の鍵' });
    fireEvent.change(screen.getByLabelText('認証トークン'), { target: { value: 'tok-1' } });

    await waitFor(() => {
      expect(calls.some((url) => url.searchParams.get('tokenId') === 'tok-1')).toBe(true);
    });
  });

  it('対照: manager 欄に入れた値は GET /usage の managerId に載る', async () => {
    const calls = stubUsageCalls();
    renderUsage();

    await screen.findByText(/この期間の使用量の記録はありません/);
    await screen.findByRole('option', { name: /^調査（/ });
    fireEvent.change(screen.getByLabelText('マネージャー'), { target: { value: 'mgr-1' } });

    await waitFor(() => {
      expect(calls.some((url) => url.searchParams.get('managerId') === 'mgr-1')).toBe(true);
    });
  });
});
