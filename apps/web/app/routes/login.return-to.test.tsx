// @vitest-environment jsdom
/**
 * ログインし直すと、開こうとしていた画面へ戻る（#3892）。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeCredential, storePendingLogin, type Credential } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Login from './login';
import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

const CREDENTIAL: Credential = {
  token: 'alt_back',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  vi.spyOn(window, 'open').mockReturnValue({} as Window);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  sessionStorage.clear();
});

function renderApp(entry: string | { pathname: string; state: unknown }) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [
          { index: true, element: <p>ホームの中身</p> },
          { path: 'memory/foo', element: <p>記憶の中身</p> },
        ],
      },
      { path: '/login', Component: Login },
    ],
    { initialEntries: [entry] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

describe('未ログインで開いた画面へ、ログインのあとに戻る', () => {
  it('未ログインで /memory/foo?a=1#x を開くと、ログイン画面へ元の場所を渡す', async () => {
    stubFetch((url) => (url.endsWith('/health') ? json(HEALTH) : undefined));
    const router = renderApp('/memory/foo?a=1#x');

    await screen.findByRole('button', { name: /Google で続ける/ });
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.state).toEqual({ from: '/memory/foo?a=1#x' });
  });

  it('ログインに成功すると、元の場所へ戻る', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      if (url.endsWith('/claim')) {
        return json({
          status: 'ready',
          token: 'alt_back',
          account: CREDENTIAL.account,
          granted: true,
        });
      }
      return undefined;
    });
    storePendingLogin({
      requestId: 'req-1',
      claimSecret: 'shhh',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      provider: 'google',
      baseUrl: TEST_BASE_URL,
    });
    const router = renderApp({ pathname: '/login', state: { from: '/memory/foo?a=1' } });

    await waitFor(() => expect(router.state.location.pathname).toBe('/memory/foo'));
    expect(router.state.location.search).toBe('?a=1');
  });

  it('既にログイン済みで /login を開いていても、元の場所へ戻る', async () => {
    storeCredential(TEST_BASE_URL, CREDENTIAL);
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      return undefined;
    });
    const router = renderApp({ pathname: '/login', state: { from: '/memory/foo' } });

    await waitFor(() => expect(router.state.location.pathname).toBe('/memory/foo'));
  });

  it.each([
    ['別オリジン', 'https://evil.example/'],
    ['プロトコル相対', '//evil.example/'],
    ['バックスラッシュ', '/\\evil.example/'],
    ['ログイン画面自体', '/login'],
  ])('%s は戻り先にせず、ホームへ戻る', async (_name, from) => {
    storeCredential(TEST_BASE_URL, CREDENTIAL);
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      return undefined;
    });
    const router = renderApp({ pathname: '/login', state: { from } });

    await screen.findByText('ホームの中身');
    expect(router.state.location.pathname).toBe('/');
  });

  it('戻り先が無ければ（直接 /login を開いた）ホームへ戻る', async () => {
    storeCredential(TEST_BASE_URL, CREDENTIAL);
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      return undefined;
    });
    const router = renderApp('/login');

    await screen.findByText('ホームの中身');
    expect(router.state.location.pathname).toBe('/');
  });
});
