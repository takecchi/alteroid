// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useApiContext } from '@alteroid/swr';
import { storeEndpoints } from '@alteroid/logic';
import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  sse,
  stubFetch,
  storeTestBaseUrl,
  TEST_BASE_URL,
} from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

const OTHER_BASE_URL = 'http://other.test:8787';

// 切り替えと名前の変更は、設定画面と同じ口（useApiContext）から叩く
function Switcher() {
  const { setBaseUrl, saveEndpoint } = useApiContext();
  return (
    <div>
      <button type="button" onClick={() => setBaseUrl(OTHER_BASE_URL)}>
        切り替える
      </button>
      <button type="button" onClick={() => saveEndpoint({ url: OTHER_BASE_URL, label: '検証機' })}>
        名前を付ける
      </button>
    </div>
  );
}

function renderShell() {
  const router = createMemoryRouter(
    [{ path: '/', Component: Shell, children: [{ index: true, Component: Switcher }] }],
    { initialEntries: ['/'] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function stubAuthedShell() {
  return stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/conversations/unread-count')) return json({ count: 0, capped: false });
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    return undefined;
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
});

describe('接続状態の札の隣の接続先の名前', () => {
  it('登録した名前を出し、title に URL まで載せる', async () => {
    storeEndpoints([{ url: TEST_BASE_URL, label: '自宅' }]);
    stubAuthedShell();
    renderShell();

    const name = await screen.findByTitle(`自宅 — ${TEST_BASE_URL}`);
    expect(name.textContent).toBe('接続先 自宅');
  });

  it('名前の無い接続先はホスト名を出し、切り替えと名前の変更に追随する', async () => {
    stubAuthedShell();
    renderShell();

    expect((await screen.findByTitle(TEST_BASE_URL)).textContent).toBe('接続先 daemon.test');

    fireEvent.click(await screen.findByRole('button', { name: '切り替える' }));
    expect((await screen.findByTitle(OTHER_BASE_URL)).textContent).toBe('接続先 other.test:8787');
    expect(screen.queryByTitle(TEST_BASE_URL)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '名前を付ける' }));
    expect((await screen.findByTitle(`検証機 — ${OTHER_BASE_URL}`)).textContent).toBe(
      '接続先 検証機',
    );
  });

  it('狭い画面の上端にも出る', async () => {
    setViewportWidth(375);
    storeEndpoints([{ url: TEST_BASE_URL, label: '自宅' }]);
    stubAuthedShell();
    renderShell();

    const banner = await screen.findByRole('banner');
    expect(banner.querySelector(`[title="自宅 — ${TEST_BASE_URL}"]`)?.textContent).toBe(
      '接続先 自宅',
    );
  });
});
