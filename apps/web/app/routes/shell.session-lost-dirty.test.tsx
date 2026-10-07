// @vitest-environment jsdom
/**
 * 書きかけのまま認証が切れても、書きかけを黙って失わない（#3912）。
 *
 * 書きかけが無ければ従来どおり `/login` へ移る（#3892 / #3911 の `state.from` も保つ）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  token: 'alt_lost',
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
let me: 'ok' | 'expired' | 'ungranted';

function routes(url: string): Response | undefined {
  if (url.endsWith('/health')) return json(HEALTH);
  if (url.endsWith('/auth/me')) {
    if (me === 'expired') return json({ error: 'expired' }, 401);
    if (me === 'ungranted') return json({ error: 'ungranted' }, 403);
    return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
  }
  if (url.endsWith('/auth/login')) {
    return json({
      requestId: 'req-1',
      claimSecret: 'shhh',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      authorizationUrl: 'http://idp.test/authorize',
    });
  }
  if (url.endsWith('/claim')) {
    return json({
      status: 'ready',
      token: 'alt_again',
      account: CREDENTIAL.account,
      granted: true,
    });
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
    { initialEntries: ['/memory/foo?a=1'] },
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

async function focusWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
  storeCredential(TEST_BASE_URL, CREDENTIAL);
  me = 'ok';
  vi.spyOn(window, 'open').mockReturnValue({} as Window);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  sessionStorage.clear();
});

describe('書きかけのまま認証が切れたとき（#3912）', () => {
  it('鍵が失効しても画面を外さず、書きかけが残り、帯でログインし直せると知らせる', async () => {
    stubFetch(routes);
    const router = renderApp();
    const input = await typeDraft();

    me = 'expired';
    await focusWindow();

    expect(await screen.findByRole('button', { name: 'Google でログインし直す' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('書きかけは画面に残っている');
    expect(router.state.location.pathname).toBe('/memory/foo');
    expect(screen.getByLabelText<HTMLInputElement>('下書き')).toBe(input);
    expect(input.value).toBe('書きかけ');
  });

  it('許可が取り消されたときも画面は残り、出口は「破棄してログイン画面へ」だけ', async () => {
    stubFetch(routes);
    const router = renderApp();
    const input = await typeDraft();

    me = 'ungranted';
    await focusWindow();

    expect(await screen.findByRole('button', { name: '破棄してログイン画面へ' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /でログインし直す/ })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('控えてから離れてほしい');
    expect(router.state.location.pathname).toBe('/memory/foo');
    expect(input.value).toBe('書きかけ');
  });

  it('書きかけが無ければ、従来どおり /login へ移り、元の場所を渡す', async () => {
    stubFetch(routes);
    const router = renderApp();
    await screen.findByLabelText('下書き');

    me = 'expired';
    await focusWindow();

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.state).toEqual({ from: '/memory/foo?a=1' });
  });

  it('保持している間に書きかけを自分で消すと、/login へ移る', async () => {
    stubFetch(routes);
    const router = renderApp();
    const input = await typeDraft();
    me = 'expired';
    await focusWindow();
    await screen.findByRole('alert');

    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('「破棄してログイン画面へ」は確認なしで /login へ移り、元の場所を渡す', async () => {
    stubFetch(routes);
    const router = renderApp();
    await typeDraft();
    me = 'expired';
    await focusWindow();

    fireEvent.click(await screen.findByRole('button', { name: '破棄してログイン画面へ' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.state).toEqual({ from: '/memory/foo?a=1' });
  });

  it('保持している間は、承認待ち・未読の取得を止める', async () => {
    const stub = stubFetch(routes);
    renderApp();
    await typeDraft();
    await waitFor(() => expect(stub.calls.some((url) => url.includes('/approvals'))).toBe(true));
    me = 'expired';
    await focusWindow();
    await screen.findByRole('alert');

    const before = stub.calls.filter(
      (url) => url.includes('/approvals') || url.includes('/unread-count'),
    ).length;
    await focusWindow();

    expect(
      stub.calls.filter((url) => url.includes('/approvals') || url.includes('/unread-count')),
    ).toHaveLength(before);
  });

  it('帯からログインし直すと、帯が消えて同じ画面・同じ書きかけのまま続けられる', async () => {
    const stub = stubFetch(routes);
    const router = renderApp();
    const input = await typeDraft();
    me = 'expired';
    await focusWindow();

    const button = await screen.findByRole('button', { name: 'Google でログインし直す' });
    me = 'ok';
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(stub.calls.some((url) => url.endsWith('/claim'))).toBe(true);
    expect(router.state.location.pathname).toBe('/memory/foo');
    expect(screen.getByLabelText<HTMLInputElement>('下書き')).toBe(input);
    expect(input.value).toBe('書きかけ');
  });
});
