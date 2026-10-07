// @vitest-environment jsdom
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const MANAGER_A = 'mgr-aaaaaaaa-1111';
const MANAGER_B = 'mgr-bbbbbbbb-2222';
const TOKEN_A = 'tok-aaaaaaaa-1111';
const TOKEN_B = 'tok-bbbbbbbb-2222';

function row(managerId: string, tokenId: string, costUsd: number) {
  return {
    date: '2026-08-14',
    managerId,
    model: 'claude-opus-4',
    layer: 'manager',
    site: 'session',
    tokenId,
    updatedAt: '2026-08-14T10:00:00.000Z',
    totals: { ...ZERO_USAGE, costUsd },
  };
}

function stubLists(lists: { managers: Response | undefined; tokens: Response | undefined }) {
  stubFetch((url) => {
    if (url.includes('/managers')) return lists.managers;
    if (url.includes('/tokens')) return lists.tokens;
    if (!url.includes('/usage')) return undefined;
    return json({
      rows: [row(MANAGER_A, TOKEN_A, 2), row(MANAGER_B, TOKEN_B, 1)],
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
}

function renderUsage() {
  const router = createMemoryRouter([{ path: '/', Component: Usage }], { initialEntries: ['/'] });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function axisCard(title: string): HTMLElement {
  const card = screen.getByRole('heading', { name: title }).closest('[data-slot="card"]');
  if (card === null) throw new Error(`${title} のカードが見つからない`);
  return card as HTMLElement;
}

describe('/usage 画面 — 名前の一覧が読めないとき', () => {
  it('一覧が失敗したら「一覧に無い」と言わず、id の先頭8文字で区別し、読めていない旨を添える', async () => {
    stubLists({
      managers: json({ error: 'boom' }, 500),
      tokens: json({ error: 'boom' }, 500),
    });
    renderUsage();

    expect(await screen.findByText(/委譲の一覧を読めていないので、名前を出せない/)).toBeTruthy();
    expect(screen.getByText(/認証トークンの一覧を読めていないので、名前を出せない/)).toBeTruthy();

    const managers = axisCard('マネージャー別');
    expect(within(managers).getByText('mgr-aaaa')).toBeTruthy();
    expect(within(managers).getByText('mgr-bbbb')).toBeTruthy();
    const tokens = axisCard('認証トークン別');
    expect(within(tokens).getByText('tok-aaaa')).toBeTruthy();
    expect(within(tokens).getByText('tok-bbbb')).toBeTruthy();
    expect(screen.queryByText(/一覧に無い/)).toBeNull();
    expect(screen.queryByText(/読み込めませんでした|読めませんでした/)).toBeNull();
  });

  it('一覧が取れていて、そこに無い id は「一覧に無い」と言う（注記は出さない）', async () => {
    stubLists({
      managers: json({ managers: [] }),
      tokens: json({ tokens: [] }),
    });
    renderUsage();

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    expect(within(managers).getAllByText(/^（一覧に無い委譲）/)).toHaveLength(2);
    expect(
      within(axisCard('認証トークン別')).getAllByText(/^（一覧に無い認証トークン）/),
    ).toHaveLength(2);
    expect(screen.queryByText(/一覧を読めていない/)).toBeNull();
    expect(within(managers).queryByText('mgr-aaaa')).toBeNull();
  });

  it('一覧にある id は名前で出る（注記も短い id も出ない）', async () => {
    stubLists({
      managers: json({
        managers: [
          { managerId: MANAGER_A, request: '一つ目の依頼', startedAt: '2026-08-14T01:00:00.000Z' },
          { managerId: MANAGER_B, request: '二つ目の依頼', startedAt: '2026-08-14T02:00:00.000Z' },
        ],
      }),
      tokens: json({
        tokens: [
          { id: TOKEN_A, label: '個人の鍵' },
          { id: TOKEN_B, label: '共有の鍵' },
        ],
      }),
    });
    renderUsage();

    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = axisCard('マネージャー別');
    expect(await within(managers).findByText(/^一つ目の依頼（/)).toBeTruthy();
    expect(within(managers).getByText(/^二つ目の依頼（/)).toBeTruthy();
    const tokens = axisCard('認証トークン別');
    expect(within(tokens).getByText('個人の鍵')).toBeTruthy();
    expect(within(tokens).getByText('共有の鍵')).toBeTruthy();
    expect(screen.queryByText(/一覧に無い|一覧を読めていない/)).toBeNull();
    expect(within(managers).queryByText('mgr-aaaa')).toBeNull();
  });
});

describe('/usage 表示名が重なる行（issue #3739）', () => {
  it('一覧に無い委譲・トークンが複数あると、id の先頭を添えて別々に出す。key の警告も出ない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubLists({ managers: json({ managers: [] }), tokens: json({ tokens: [] }) });
    renderUsage();
    await screen.findByRole('heading', { name: 'マネージャー別' });
    const managers = within(axisCard('マネージャー別'));
    expect(await managers.findByText('（一覧に無い委譲）（mgr-aaaa）')).toBeTruthy();
    expect(managers.getByText('（一覧に無い委譲）（mgr-bbbb）')).toBeTruthy();
    const tokens = within(axisCard('認証トークン別'));
    expect(tokens.getByText('（一覧に無い認証トークン）（tok-aaaa）')).toBeTruthy();
    expect(tokens.getByText('（一覧に無い認証トークン）（tok-bbbb）')).toBeTruthy();
    expect(error).not.toHaveBeenCalled();
  });
});
