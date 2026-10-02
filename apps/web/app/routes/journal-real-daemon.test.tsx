// @vitest-environment jsdom
/**
 * 日誌画面を、fetch のスタブではなく **実デーモンの Hono アプリ**（`apps/daemon/src/app.ts` の
 * `createApp`）につないで試す（Issue #2625）。`fetch` の差し替え先が `app.fetch` なので、
 * `GET /journal` の `next` / `afterId` / `afterAt` / `horizon` は本物の経路・検証・応答の形を通る。
 *
 * **置き場所の判断。** `apps/web` から `apps/daemon` を相対で読むのはテストだけである（本番の
 * import ではない）。画面（もっと遡る・地平の注記）を描けるのは web 側だけで、daemon 側に置くと
 * react / jsdom / testing-library を daemon の依存へ足すことになるため、こちらに置く。
 *
 * ストアはメモリ。pg の `list()` は `LIMIT` の **後** で読めない行を捨てるので、その形を
 * `pgShaped` で再現する（fs・メモリは読めない行を数える前に飛ばすので、短い頁は起きない）。
 */
import { createMemoryStores } from '@alteroid/core';
import type { JournalEntry, JournalStore, Stores } from '@alteroid/core';
import { JournalFeedProvider } from '@alteroid/swr';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Providers, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import { createApp } from '../../../daemon/src/app.js';

import Journal from './journal';

const BASE = new Date('2026-03-01T00:00:00.000Z').getTime();

function entry(i: number): JournalEntry {
  return {
    type: 'decision',
    id: `e${String(i).padStart(4, '0')}`,
    at: new Date(BASE - i * 60_000).toISOString(),
    decision: `d${i}`,
    grounds: 'g',
  };
}

/** 新しい順に total 件（index 0 が最新）を持つメモリの日誌。 */
function seeded(total: number, unreadable: (i: number) => boolean = () => false) {
  const all = Array.from({ length: total }, (_, i) => entry(i));
  const bad = new Set(all.filter((_, i) => unreadable(i)).map((e) => e.id));
  const base = createMemoryStores().journal;
  const store: JournalStore = {
    ...base,
    async oldestAt() {
      return all.at(-1)?.at ?? null;
    },
    async list(query = {}) {
      return (await store.listPage(query)).entries;
    },
    // pg の形: limit + 1 行を生で読み、頁を切ってから読めない行を捨てる。
    async listPage(query = {}) {
      const limit = query.limit ?? all.length;
      let from = 0;
      if (query.after !== undefined) {
        const idx = all.findIndex((e) => e.id === query.after!.id && e.at === query.after!.at);
        if (idx < 0) throw new Error('anchor not found');
        from = idx + 1;
      }
      const raw = all
        .slice(from)
        .filter((e) => (query.until === undefined ? true : e.at <= query.until));
      const page = raw.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.filter((e) => !bad.has(e.id)),
        next: raw.length > limit && last !== undefined ? { id: last.id, at: last.at } : null,
      };
    },
  };
  return { store, all };
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
    mount(seeded(250).store);

    fireEvent.click(await screen.findByRole('button', MORE));
    await waitFor(() => expect(requests).toHaveLength(2));
    // 2頁目は 1頁目の next（100件目の行）を継続点にする。
    expect(requests[1]!.searchParams.get('afterId')).toBe('e0099');
    expect(requests[1]!.searchParams.get('afterAt')).toBe(entry(99).at);

    fireEvent.click(await screen.findByRole('button', MORE));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.searchParams.get('afterId')).toBe('e0199');

    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(screen.queryByRole('button', MORE)).toBeNull();
    // 最後の頁で終わりを言ったあとは、もう撃たない。
    expect(requests).toHaveLength(3);
  });

  it('日誌が初回の頁にちょうど収まるなら、押さずに終わりが出る', async () => {
    mount(seeded(40).store);
    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(screen.queryByRole('button', MORE)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('読めない行で頁が短くなっても（pg の形）終わりと言わず、継続点で先を読む', async () => {
    // 初回の頁（0..99）のうち 3 行が読めず 97 件で返る。以前はこれを終端と読んだ。
    mount(seeded(250, (i) => i === 10 || i === 50 || i === 98).store);

    const more = await screen.findByRole('button', MORE);
    expect(screen.queryByText(/これより古い記録は無い/)).toBeNull();
    expect(requests[0]!.searchParams.get('afterId')).toBeNull();

    fireEvent.click(more);
    await waitFor(() => expect(requests).toHaveLength(2));
    // 継続点は捨てた行を含む頁の最後の生の行（99 件目）。
    expect(requests[1]!.searchParams.get('afterId')).toBe('e0099');

    fireEvent.click(await screen.findByRole('button', MORE));
    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  it('頁が丸ごと読めなくても、空の頁を終端と読まずに読み継ぐ', async () => {
    mount(seeded(250, (i) => i >= 100 && i < 200).store);

    fireEvent.click(await screen.findByRole('button', MORE));
    // 2頁目は全部読めない（空）が、next が先を指すので続けて読んで終端まで行く。
    expect(await screen.findByText(/これより古い記録は無い/)).toBeTruthy();
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.at(-1)!.searchParams.get('afterId')).toBe('e0199');
  });
});
