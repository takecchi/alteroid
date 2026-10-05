// @vitest-environment jsdom
/**
 * `/usage` 画面の token 欄が問い合わせに効くこと（issue #2059）。
 *
 * 画面は `tokenId` を `query` に積んでいたが、`useUsage`（`hooks/queries.ts`）の
 * fetcher が `from` / `to` / `managerId` / `layer` / `site` しか `GET /usage` へ
 * 渡していなかった——欄に入れても絞り込まれず、全体の数字が出続けていた。
 * デーモンは `tokenId` を受け付ける（`apps/daemon/openapi.json` の `/usage`）。
 *
 * **別ファイルにしてあるのは、`usage.test.tsx` を並行する PR（#2050）が
 * 書き換えているためである。** 測るのは「欄の値が URL に載るか」だけで、
 * 描画の中身は `usage.test.tsx` が持つ。
 */
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

    await screen.findByText(/その範囲には記録が無い/);
    fireEvent.change(screen.getByPlaceholderText('トークンの番号'), { target: { value: 'tok-1' } });

    await waitFor(() => {
      expect(calls.some((url) => url.searchParams.get('tokenId') === 'tok-1')).toBe(true);
    });
  });

  /**
   * 対照: 同じ経路で managerId は前から載っていた。こちらが通って token だけが
   * 落ちるなら、落ちているのは欄ではなく fetcher の取り出しである。
   */
  it('対照: manager 欄に入れた値は GET /usage の managerId に載る', async () => {
    const calls = stubUsageCalls();
    renderUsage();

    await screen.findByText(/その範囲には記録が無い/);
    fireEvent.change(screen.getByPlaceholderText('マネージャーの番号'), {
      target: { value: 'mgr-1' },
    });

    await waitFor(() => {
      expect(calls.some((url) => url.searchParams.get('managerId') === 'mgr-1')).toBe(true);
    });
  });
});
