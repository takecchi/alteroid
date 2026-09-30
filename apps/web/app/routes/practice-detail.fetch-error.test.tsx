// @vitest-environment jsdom
/**
 * やり方の詳細の取得に失敗したとき、空の編集欄と保存ボタンを出さない（issue #2319）。
 *
 * 読めていないのに空の編集欄が出ると、既存のやり方を空のまま上書き保存できてしまう。
 * 404（これから書く）だけは失敗ではないので、空の編集欄を出す。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Practice } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/practice-detail';
import PracticeDetail, { clientLoader } from './practice-detail';

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

/** `GET /practices/daily-report` にだけ `respond()` の応答を返す。他の URL は「繋がらない」。 */
function stubPractice(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/practices/daily-report') return respond();
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
}

function Harness() {
  const loaderData = clientLoader({ params: { slug: 'daily-report' } } as Route.ClientLoaderArgs);
  return <PracticeDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/practices/:slug', Component: Harness },
      { path: '/practices', Component: () => null },
    ],
    { initialEntries: ['/practices/daily-report'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const DOC: Practice = {
  slug: 'daily-report',
  kind: '日報',
  title: '日報の書き方',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  chars: 42,
  content: '# 見出し\n\n本文だよ',
};

describe('やり方の取得に失敗したとき（issue #2319）', () => {
  it('サーバの失敗（500）: エラーだけを出し、編集欄と保存ボタンは出さない', async () => {
    stubPractice(() => json({ error: 'internal' }, 500));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /保存する|変更なし/ })).toBeNull();
  });

  it('通信の失敗: エラーだけを出し、編集欄と保存ボタンは出さない', async () => {
    stubPractice(() => Promise.reject(new TypeError('Failed to fetch')));
    renderPage();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: /保存する|変更なし/ })).toBeNull();
  });

  it('404（これから書く）なら、失敗とせず空の編集欄を出す', async () => {
    stubPractice(() => json({ error: 'not found' }, 404));
    renderPage();

    expect((await screen.findAllByRole('textbox')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /保存する|変更なし/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('再検証の失敗で本文が読めたまま残っているときは、編集欄を隠さない（失敗は注記で知らせる）', async () => {
    let calls = 0;
    stubPractice(() => {
      calls += 1;
      if (calls === 1) return json({ practice: DOC });
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
