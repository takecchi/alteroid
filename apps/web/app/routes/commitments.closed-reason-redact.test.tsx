// @vitest-environment jsdom
/**
 * #3870。片付けた理由（`closedReason`）は本文と同じく `redactBody` を通して出す。
 * `closedBy` の4状態（clone・human・無い・未知）と、「既に片付いた」の断りの3経路すべてで測る
 * （経路ごとに描き方が違い、素の `<p>` に出す経路が伏せ忘れの出どころだった）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Commitment } from '@alteroid/core';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

const CLOSED: Commitment = {
  id: 'cmt-1',
  at: '2026-09-01T00:00:00.000Z',
  origin: 'human',
  body: 'もとの本文',
  closedAt: '2026-09-01T01:00:00.000Z',
  closedReason: `理由 ${SECRET}`,
};

function stubEntries(server: { entries: Commitment[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/commitments'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    return json({ entries: server.entries });
  }) as typeof fetch;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/', Component: Commitments }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('片付けた理由を伏せて出す（#3870）', () => {
  it.each([
    ['clone', { closedBy: 'clone' }],
    ['human', { closedBy: 'human' }],
    ['closedBy が無い', {}],
    ['未知の closedBy', { closedBy: 'someone-new' }],
  ])('%s の行でも、理由の秘密を伏せる', async (_name, over) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubEntries({ entries: [{ ...CLOSED, ...over }] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '片付けたものも見る' }));
    await waitFor(() => expect(document.body.textContent).toContain('どう片付いたか'));
    expect(document.body.textContent).toContain('理由 ');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('「既に片付いた」の断りに出す理由も伏せる', async () => {
    const open: Commitment = { id: 'cmt-1', at: CLOSED.at, origin: 'human', body: 'もとの本文' };
    const server = { entries: [open] };
    stubEntries(server);
    renderPage();
    await screen.findByText('もとの本文');
    fireEvent.change(screen.getByLabelText(/を片付けた理由$/), { target: { value: '書きかけ' } });

    server.entries = [{ ...CLOSED, closedBy: 'human' }];
    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));

    const orphans = await screen.findByRole('list', { name: '一覧から外れた仕事' });
    await waitFor(() => expect(within(orphans).getByText(/片付けた理由:/)).toBeTruthy());
    expect(orphans.textContent).toContain('理由 ');
    expect(orphans.textContent).not.toContain(SECRET);
  });
});
