// @vitest-environment jsdom
/**
 * 書きかけがあるときのログアウトは、確認してから進み、帯を出さずに /login へ移る（#3919）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential, type Credential } from '@alteroid/logic';
import { LeaveGuardScope, useReportDirty } from '~/lib/leave-guard';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Shell from './shell';

const HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

const CREDENTIAL: Credential = {
  token: 'alt_out',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

function Draft() {
  const [text, setText] = useState('');
  useReportDirty('draft', text !== '');
  return <input aria-label="下書き" value={text} onChange={(e) => setText(e.target.value)} />;
}

function DraftScreen() {
  return (
    <LeaveGuardScope>
      <Draft />
    </LeaveGuardScope>
  );
}

let originalFetch: typeof fetch;
let loggedOut: boolean;

function routes(url: string): Response | undefined {
  if (url.endsWith('/health')) return json(HEALTH);
  if (url.endsWith('/auth/me')) {
    return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
  }
  if (url.endsWith('/auth/logout')) {
    loggedOut = true;
    return json({ ok: true });
  }
  return undefined;
}

function renderApp() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [{ path: 'memory/foo', Component: DraftScreen }],
      },
      { path: '/login', element: <p>ログイン画面</p> },
    ],
    { initialEntries: ['/memory/foo'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

async function typeDraft(): Promise<HTMLInputElement> {
  const input = await screen.findByLabelText<HTMLInputElement>('下書き');
  fireEvent.change(input, { target: { value: '書きかけ' } });
  return input;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  storeCredential(TEST_BASE_URL, CREDENTIAL);
  loggedOut = false;
  stubFetch(routes);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  sessionStorage.clear();
});

describe('書きかけのままログアウトするとき（#3919）', () => {
  it('確認が出て、答えるまでサーバへの失効も画面の差し替えも起きない', async () => {
    renderApp();
    await typeDraft();

    fireEvent.click(await screen.findByRole('button', { name: 'ログアウト' }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('保存していない変更があります')).toBeTruthy();
    expect(loggedOut).toBe(false);
  });

  it('確認して進むと、「ログインが切れた」の帯を出さずに /login へ移る', async () => {
    const router = renderApp();
    await typeDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'ログアウト' }));

    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(loggedOut).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('取りやめると、画面と書きかけが残り、ログアウトもされない', async () => {
    const router = renderApp();
    const input = await typeDraft();
    fireEvent.click(await screen.findByRole('button', { name: 'ログアウト' }));

    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/memory/foo');
    expect(screen.getByLabelText<HTMLInputElement>('下書き')).toBe(input);
    expect(input.value).toBe('書きかけ');
    expect(loggedOut).toBe(false);
  });

  it('書きかけが無ければ、従来どおり確認なしでログアウトして /login へ移る', async () => {
    const router = renderApp();
    await screen.findByLabelText('下書き');

    fireEvent.click(await screen.findByRole('button', { name: 'ログアウト' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(loggedOut).toBe(true);
  });
});
