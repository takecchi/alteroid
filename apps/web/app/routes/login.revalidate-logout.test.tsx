// @vitest-environment jsdom
/**
 * 「許可されたか確認する」と、ログアウトの進行中の表示・結果・二度押しの門（#3738）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatTime, storeCredential } from '@alteroid/logic';
import type { Credential } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Login from './login';

const CREDENTIAL: Credential = {
  token: 'alt_ungranted',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

const HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  storeCredential(TEST_BASE_URL, CREDENTIAL);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

/** 手で開け閉めできる応答。進行中の表示を見るために、応答を保留にする。 */
function gate() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function renderUngranted(route: (url: string) => Response | Promise<Response> | undefined) {
  const stub = stubFetch((url) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.endsWith('/auth/me')) return route(url) ?? json({ error: '使う許可が無い' }, 403);
    return route(url);
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

describe('「許可されたか確認する」（#3738）', () => {
  it('確かめている間は読み込み中になり、まだ許可が無ければ「まだ許可されていない（時刻）」を出す', async () => {
    const held = gate();
    let armed = false;
    renderUngranted((url) => {
      if (url.endsWith('/auth/me') && armed) return held.promise;
      return undefined;
    });
    const button = await screen.findByRole('button', { name: '許可されたか確認する' });
    expect(screen.queryByRole('status')).toBeNull();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T09:41:00'));
    armed = true;
    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    // 確かめている間は、結果の表示を出さない。
    expect(screen.queryByRole('status')).toBeNull();

    await act(async () => {
      held.release(json({ error: '使う許可が無い' }, 403));
      await held.promise;
    });

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('まだ許可されていない');
    expect(status.textContent).toContain(formatTime(new Date('2026-10-07T09:41:00').toISOString()));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });

  it('確認そのものが失敗したら、「まだ許可されていない」とは言わない', async () => {
    let failing = false;
    stubFetch((url) => {
      if (url.endsWith('/health')) return failing ? json({ error: 'boom' }, 500) : json(HEALTH);
      if (url.endsWith('/auth/me')) return json({ error: '使う許可が無い' }, 403);
      return undefined;
    });
    render(
      <Providers>
        <Login />
      </Providers>,
    );
    const button = await screen.findByRole('button', { name: '許可されたか確認する' });

    failing = true;
    fireEvent.click(button);

    await screen.findByRole('button', { name: /もう一度試す/ });
    expect(screen.queryByText(/まだ許可されていない/)).toBeNull();
  });
});

describe('Ungranted の「別のアカウントでログイン」の二度押し（#3738）', () => {
  it('送信中は読み込み中になり、二度押しでも要求は1回だけ', async () => {
    const held = gate();
    const stub = renderUngranted((url) =>
      url.endsWith('/auth/logout') ? held.promise : undefined,
    );
    const button = await screen.findByRole('button', { name: '別のアカウントでログイン' });

    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    fireEvent.click(button);
    expect(stub.calls.filter((url) => url.endsWith('/auth/logout'))).toHaveLength(1);

    // 失敗で戻ったら、また押せる。
    await act(async () => {
      held.release(json({ error: '落ちた' }, 500));
      await held.promise;
    });
    await screen.findByText(/サーバ側を失効させられなかった/);
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });
});
