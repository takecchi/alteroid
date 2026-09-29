// @vitest-environment jsdom
/**
 * 行き先の「いま居る画面」の印（`aria-current`）。
 *
 * `NAV` の `end` は `AppSidebarItem` に無いので、`shell.tsx` の `renderLink` が
 * `NavLink` へ渡し直している。どの画面に居てもダッシュボードが選択中になる、という
 * 壊れ方は他の試験が見ていないので、結果（`aria-current`）の側で測る。
 *
 * **⚠️ この試験は `end` の渡し忘れそのものは捕まえない。** 実測（react-router の
 * `NavLink`、`to="/"` は末尾の区切りの判定が `charAt(1) === "/"` になるので `end` が
 * 無くても `/chat` では選択中にならない）: `end` を `false` に固定しても緑のまま。
 * 測っているのは、リンクの作り替え（`renderLink` / `sidebarLinkClassName` の経路）で
 * 「選択中」の判定が壊れていないことである。
 *
 * 保証すること:
 * 1. `/chat` に居るとき、ダッシュボードのリンクに `aria-current` が付かない。会話のリンクには付く（印そのものが出ている）
 * 2. `/` に居るときは、ダッシュボードに `aria-current="page"` が付く
 *    （1 が「何も付けない」ことで緑になっていないこと）
 */
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VIEWPORT_WIDTH,
  json,
  Providers,
  setViewportWidth,
  sse,
  stubFetch,
  storeTestBaseUrl,
} from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

function renderShellAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [
          { index: true, Component: () => <div>ダッシュボードの中身</div> },
          { path: 'chat', Component: () => <div>会話の中身</div> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
  stubFetch((url, init) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.includes('/approvals')) return json({ approvals: [] });
    if (url.endsWith('/journal/stream')) return sse([], { keepOpen: true, signal: init?.signal });
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('行き先の選択中の印', () => {
  it('/chat に居るとき、ダッシュボードは選択中にならず、会話がなる', async () => {
    renderShellAt('/chat');

    expect(await screen.findByText('会話の中身')).toBeTruthy();
    const dashboard = screen.getByRole('link', { name: 'ダッシュボード' });
    const chat = screen.getByRole('link', { name: '会話' });
    expect(dashboard.getAttribute('aria-current')).toBeNull();
    expect(chat.getAttribute('aria-current')).toBe('page');
  });

  it('/ に居るとき、ダッシュボードが選択中になる', async () => {
    renderShellAt('/');

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'ダッシュボード' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: '会話' }).getAttribute('aria-current')).toBeNull();
  });
});
