// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential, type Credential } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Shell from './shell';

function fixEndpointFromScreen(url: string): void {
  fireEvent.change(screen.getByLabelText('追加する接続先の URL'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: '追加して接続' }));
}

const HEALTH = {
  ok: true,
  pid: 1,
  operator: true,
  storage: '/tmp/alteroid',
  auth: { enabled: false, providers: [] },
};

const REMOTE = 'http://daemon.example';

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [{ index: true, Component: () => <div>ダッシュボードの中身</div> }],
      },
    ],
    { initialEntries: ['/'] },
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
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('接続できないとき', () => {
  it('その画面で接続先を直して復帰できる（設定画面へ行けないため）', async () => {
    const stub = stubFetch((url) => (url.startsWith(REMOTE) ? json(HEALTH) : undefined));

    renderShell();

    expect(await screen.findByText('接続先のサーバに繋がらない')).toBeTruthy();
    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input).toBeTruthy();

    expect(screen.queryByText('ダッシュボードの中身')).toBeNull();

    fixEndpointFromScreen(REMOTE);

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(REMOTE);
    expect(stub.calls.some((url) => url === `${REMOTE}/health`)).toBe(true);
  });

  it('誤った接続先を保存してしまっても、そこから直せる', async () => {
    localStorage.setItem('alteroid.apiBaseUrl', 'http://typo.example');
    stubFetch((url) => (url.startsWith(REMOTE) ? json(HEALTH) : undefined));

    renderShell();

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe('http://typo.example');

    fixEndpointFromScreen(REMOTE);

    expect(await screen.findByText('ダッシュボードの中身')).toBeTruthy();
  });

  it('「既定に戻す」で保存済みの値を消せる', async () => {
    localStorage.setItem('alteroid.apiBaseUrl', 'http://typo.example');
    stubFetch(() => undefined);

    renderShell();

    fireEvent.click(await screen.findByRole('button', { name: '既定に戻す' }));

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBeNull();
    });
  });
});

const AUTH_HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

const CREDENTIAL: Credential = {
  token: 'alt_shell',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

describe('フッターのログアウト（issue #1757）', () => {
  beforeEach(() => {
    storeTestBaseUrl();
    storeCredential(TEST_BASE_URL, CREDENTIAL);
  });

  it('成功 → サーバ側のトークンを失効させ、鍵を捨てる', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(AUTH_HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      if (url.endsWith('/auth/logout')) return json({ ok: true });
      return undefined;
    });

    renderShell();

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
    });
  });

  it('送信中は読み込み中になり、二度押しでも要求は1回だけ（#3738）', async () => {
    const logouts: string[] = [];
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(AUTH_HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      if (url.endsWith('/auth/logout')) {
        logouts.push(url);
        return new Promise<Response>(() => undefined);
      }
      return undefined;
    });

    renderShell();

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    fireEvent.click(button);
    expect(logouts).toHaveLength(1);
  });

  it('失敗 → 鍵は残したままエラーを出し、「この画面から鍵だけを捨てる」で個別に捨てられる', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(AUTH_HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      if (url.endsWith('/auth/logout')) return json({ error: 'internal' }, 500);
      return undefined;
    });

    renderShell();

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);

    await screen.findByText(/サーバ側を失効させられなかった/);
    expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'この画面から鍵だけを捨てる' }));

    await waitFor(() => {
      expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
    });
  });
});
