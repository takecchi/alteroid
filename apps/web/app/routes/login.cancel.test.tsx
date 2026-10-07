// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readPendingLogin, storePendingLogin } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Login from './login';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

const STARTED = {
  requestId: 'req-1',
  authorizationUrl: 'http://auth.test/start',
  claimSecret: 'shhh',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
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

function renderSignIn() {
  const stub = stubFetch((url) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.endsWith('/auth/login')) return json(STARTED);
    if (url.endsWith('/claim')) return json({ status: 'pending' }, 202);
    return undefined;
  });
  const router = createMemoryRouter([{ path: '/login', Component: Login }], {
    initialEntries: ['/login'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return stub;
}

describe('ログインの待ちをやめる（#3736）', () => {
  it('待っている間は「やめる」が出て、押すと待ちの記録が消えボタンが押せる状態へ戻る', async () => {
    const stub = renderSignIn();
    const start = await screen.findByRole('button', { name: /Google で続ける/ });

    fireEvent.click(start);
    const cancel = await screen.findByRole('button', { name: 'やめる' });
    await waitFor(() => expect(readPendingLogin()).not.toBeNull());
    const claimsBefore = stub.calls.filter((url) => url.endsWith('/claim')).length;

    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'やめる' })).toBeNull());
    expect(readPendingLogin()).toBeNull();
    const again = screen.getByRole('button', { name: /Google で続ける/ });
    expect(again.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('待機中')).toBeNull();
    expect(stub.calls.filter((url) => url.endsWith('/claim')).length).toBe(claimsBefore);
  });

  it('読み直しで再開した待ちも「やめる」で止められる', async () => {
    storePendingLogin({
      requestId: 'req-1',
      claimSecret: 'shhh',
      expiresAt: STARTED.expiresAt,
      provider: 'google',
    });
    renderSignIn();

    const cancel = await screen.findByRole('button', { name: 'やめる' });
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'やめる' })).toBeNull());
    expect(readPendingLogin()).toBeNull();
    expect(screen.getByRole('button', { name: /Google で続ける/ }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});
