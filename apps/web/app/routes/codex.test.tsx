// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import Codex from './codex';

/**
 * Codex の ChatGPT ログインの画面（#3939）。CLI・HTTP と同じ口（`/codex/*`）を叩き、
 * ログインの確認用 URL とコードを出し、承認されたら状態が変わる。値は画面に来ない。
 */

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

const LOGGED_OUT = {
  loggedIn: false,
  email: null,
  planType: null,
  updatedAt: null,
  fingerprint: null,
  failure: null,
};

const LOGGED_IN = {
  loggedIn: true,
  email: 'me@example.com',
  planType: 'plus',
  updatedAt: '2026-10-07T01:00:00.000Z',
  fingerprint: 'abcdef012345',
  failure: null,
};

const PENDING = {
  id: 'L1',
  state: 'pending',
  verificationUrl: 'https://auth.example/device',
  userCode: 'ABCD-EFGH',
  startedAt: '2026-10-07T00:00:00.000Z',
  finishedAt: null,
  error: null,
};

// openapi-fetch は fetch(new Request(...)) の形で呼ぶので、method は Request から読む。
function stub(state: { status: unknown; login: unknown }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);
    if (path === '/codex/auth' && method === 'GET') return json(state.status);
    if (path === '/codex/auth' && method === 'DELETE') {
      state.status = LOGGED_OUT;
      return json({ removed: true });
    }
    if (path === '/codex/login' && method === 'POST') return json(PENDING);
    if (path === '/codex/login/L1' && method === 'GET') return json(state.login);
    if (path === '/codex/login/L1' && method === 'DELETE') {
      state.login = { ...PENDING, state: 'canceled', finishedAt: 'x' };
      return json(state.login);
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
  return calls;
}

function renderPage() {
  render(
    <Providers>
      <TestDataRouter>
        <Codex />
      </TestDataRouter>
    </Providers>,
  );
}

describe('Codex の画面（#3939）', () => {
  it('ログインすると確認用 URL とコードが出て、承認されると状態がログイン済みに変わる', async () => {
    const state: { status: unknown; login: unknown } = { status: LOGGED_OUT, login: PENDING };
    stub(state);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'ログイン' }));
    expect(await screen.findByText('https://auth.example/device')).toBeTruthy();
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy();

    state.login = { ...PENDING, state: 'succeeded', finishedAt: '2026-10-07T00:01:00.000Z' };
    state.status = LOGGED_IN;
    await waitFor(
      () => {
        expect(screen.getByText('ログイン済み')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(screen.getByText('me@example.com')).toBeTruthy();
  });

  it('切れていたら理由と再ログインの促しを出す', async () => {
    stub({
      status: { ...LOGGED_IN, failure: { at: '2026-10-07T02:00:00.000Z', reason: 'token revoked' } },
      login: PENDING,
    });
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('token revoked');
    expect(screen.getByRole('button', { name: '再ログイン' })).toBeTruthy();
  });

  it('ログアウトは確認してから消す', async () => {
    const state: { status: unknown; login: unknown } = { status: LOGGED_IN, login: PENDING };
    const calls = stub(state);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'ログアウト' }));
    const dialogButtons = await screen.findAllByRole('button', { name: 'ログアウト' });
    fireEvent.click(dialogButtons[dialogButtons.length - 1] as HTMLElement);
    await waitFor(() => {
      expect(calls).toContain('DELETE /codex/auth');
    });
    expect(await screen.findByText(/ログインしていない/)).toBeTruthy();
  });

  it('取り消すと、正本は変わっていないと出る', async () => {
    const state: { status: unknown; login: unknown } = { status: LOGGED_OUT, login: PENDING };
    const calls = stub(state);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'ログイン' }));
    fireEvent.click(await screen.findByRole('button', { name: '取り消す' }));
    await waitFor(() => {
      expect(calls).toContain('DELETE /codex/login/L1');
    });
    expect(await screen.findByText(/取り消した/)).toBeTruthy();
  });
});
