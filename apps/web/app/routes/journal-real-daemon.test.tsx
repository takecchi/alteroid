// @vitest-environment jsdom
// daemon 側に置かない: react / jsdom / testing-library を daemon の依存へ足すことになるため
import { createMemoryStores, createSyntheticJournalStore } from '@alteroid/core';
import type { JournalStore, Stores } from '@alteroid/core';
import { JournalFeedProvider } from '@alteroid/swr';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Providers, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import { createApp } from '../../../daemon/src/app.js';

import Journal from './journal';

const BASE = new Date('2026-03-01T00:00:00.000Z').getTime();

function seeded(total: number, unreadable: (i: number) => boolean = () => false) {
  return createSyntheticJournalStore({
    total,
    baseTimeMs: BASE,
    entryAt: (i) => ({ type: 'decision', decision: `d${i}`, grounds: 'g' }),
    unreadable,
  });
}

let originalFetch: typeof fetch;
let requests: URL[];

function mount(journal: JournalStore) {
  const base = createMemoryStores();
  const stores: Stores = { ...base, journal };
  const app = createApp({
    stores,
    token: 'test-token',
    shutdown: () => {},
  } as unknown as Parameters<typeof createApp>[0]);
  requests = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/journal') requests.push(url);
    return Promise.resolve(app.fetch(request));
  }) as typeof fetch;

  const router = createMemoryRouter([{ path: '/', Component: Journal }], { initialEntries: ['/'] });
  render(
    <Providers>
      <JournalFeedProvider value={{ status: 'live', recent: [] }}>
        <RouterProvider router={router} />
      </JournalFeedProvider>
    </Providers>,
  );
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl(TEST_BASE_URL);
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const MORE = { name: /もっと遡る/ };

describe('実デーモンにつないだ日誌画面（Issue #2625）', () => {
  it('初回の頁より長い日誌は「もっと遡る」で古い側が読め、尽きたら地平の注記が出てボタンが消える', async () => {
    const journal = seeded(250);
    mount(journal.store);

    fireEvent.click(await screen.findByRole('button', MORE));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.searchParams.get('afterId')).toBe(journal.entryOf(99).id);
    expect(requests[1]!.searchParams.get('afterAt')).toBe(journal.entryOf(99).at);

    fireEvent.click(await screen.findByRole('button', MORE));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.searchParams.get('afterId')).toBe(journal.entryOf(199).id);

    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(screen.queryByRole('button', MORE)).toBeNull();
    expect(requests).toHaveLength(3);
  });

  it('日誌が初回の頁にちょうど収まるなら、押さずに終わりが出る', async () => {
    mount(seeded(40).store);
    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(screen.queryByRole('button', MORE)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('読めない行で頁が短くなっても（pg の形）終わりと言わず、継続点で先を読む', async () => {
    const journal = seeded(250, (i) => i === 10 || i === 50 || i === 98);
    mount(journal.store);

    const more = await screen.findByRole('button', MORE);
    expect(screen.queryByText(/これより古い記録は無い/)).toBeNull();
    expect(requests[0]!.searchParams.get('afterId')).toBeNull();

    fireEvent.click(more);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.searchParams.get('afterId')).toBe(journal.entryOf(99).id);

    fireEvent.click(await screen.findByRole('button', MORE));
    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  it('頁が丸ごと読めなくても、空の頁を終端と読まずに読み継ぐ', async () => {
    const journal = seeded(250, (i) => i >= 100 && i < 200);
    mount(journal.store);

    fireEvent.click(await screen.findByRole('button', MORE));
    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.at(-1)!.searchParams.get('afterId')).toBe(journal.entryOf(199).id);
  });
});
