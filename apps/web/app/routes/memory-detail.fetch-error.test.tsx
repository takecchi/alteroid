// @vitest-environment jsdom
/**
 * 記憶詳細の取得に失敗したとき、空の編集欄と保存ボタンを出さない（issue #2319）。
 *
 * 読めていないのに空の編集欄が出ると、既存の記憶を空のまま上書き保存できてしまう。
 * 404（これから書く）だけは失敗ではないので、空の編集欄を出す。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryDocument } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/memory-detail';
import MemoryDetail, { clientLoader } from './memory-detail';

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

/** `GET /memory/notes` にだけ `respond()` の応答を返す。他の URL は「繋がらない」。 */
function stubMemory(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/memory/notes') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'notes' } } as Route.ClientLoaderArgs);
  return <MemoryDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/memory/:slug', Component: Harness },
      { path: '/memory', Component: () => null },
    ],
    { initialEntries: ['/memory/notes'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const DOC: MemoryDocument = {
  slug: 'notes',
  title: 'notes',
  updatedAt: '2026-08-22T00:00:00.000Z',
  createdAt: { kind: 'unknown' },
  bytes: 42,
  frontmatter: { kind: 'none' },
  kind: 'fact',
  descriptionFreshness: { kind: 'absent' },
  content: '# 見出し\n\n本文だよ',
};

describe('記憶の取得に失敗したとき（issue #2319）', () => {
  it('サーバの失敗（500）: エラーだけを出し、編集欄と保存ボタンは出さない', async () => {
    stubMemory(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存する|変更なし/ })).toBeNull();
  });

  it('通信の失敗: エラーだけを出し、編集欄と保存ボタンは出さない', async () => {
    stubMemory(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存する|変更なし/ })).toBeNull();
  });

  it('404（これから書く）なら、失敗とせず空の編集欄を出す', async () => {
    stubMemory(() => json({ error: 'not found' }, 404));
    renderPage();

    expect(await screen.findByRole('textbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: /保存する|変更なし/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('再検証の失敗で本文が読めたまま残っているときは、編集欄を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubMemory(() => {
      calls += 1;
      if (calls === 1) return json({ document: DOC });
      return json({ error: 'internal' }, 500);
    });
    renderPage();

    expect(await screen.findByText('本文だよ')).toBeTruthy();

    // 再検証を起こす（SWR は focus で再検証する。足場は throttle 0）。
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('本文だよ')).toBeTruthy();
    expect(screen.getByRole('button', { name: /保存する|変更なし/ })).toBeTruthy();
  });
});
