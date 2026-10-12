// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import Codex from './codex';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

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

const LOGGED_IN = {
  loggedIn: true,
  email: 'me@example.com',
  planType: 'plus',
  updatedAt: '2026-10-07T01:00:00.000Z',
  fingerprint: 'abcdef012345',
  failure: { at: '2026-10-07T02:00:00.000Z', reason: `refresh failed: GH_TOKEN=${TOKEN}` },
};

const FAILED = {
  id: 'L1',
  state: 'failed',
  verificationUrl: 'https://auth.example/device',
  userCode: 'ABCD-EFGH',
  startedAt: '2026-10-07T00:00:00.000Z',
  finishedAt: '2026-10-07T00:01:00.000Z',
  error: `app-server died: GH_TOKEN=${TOKEN}`,
};

function stub(status: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (path === '/runners') return json({ runners: [], daemonRevision: { status: 'unknown' } });
    if (path === '/codex/auth' && method === 'GET') return json(status);
    if (path === '/codex/login' && method === 'POST') return json(FAILED);
    if (path === '/codex/login/L1' && method === 'GET') return json(FAILED);
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;
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

describe('Codex の画面は、CLI の alteroid codex と同じく理由の本文の秘密を伏せる（#4519）', () => {
  it('切れている理由に入った鍵を出さない（地の文は残す）', async () => {
    stub(LOGGED_IN);
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('refresh failed');
    expect(alert.textContent).not.toContain(TOKEN);
  });

  it('ログインの失敗の理由に入った鍵を出さない（地の文は残す）', async () => {
    stub({ ...LOGGED_IN, loggedIn: false, failure: null });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'ログイン' }));
    await screen.findByText(/失敗した（正本は変わっていない）: app-server died/);
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
