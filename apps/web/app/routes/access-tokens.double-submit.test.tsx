// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import AccessTokens from './access-tokens';

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

function tokenView(id: string) {
  return {
    id,
    accountId: 'acc-1',
    name: 'CI',
    kind: 'read',
    origin: 'issued',
    issuedBy: 'acc-1',
    fingerprint: 'abcdef012345',
    createdAt: '2026-11-15T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
}

describe('/access-tokens 画面 — 発行の二重送信', () => {
  it('発行の応答を待つ間に Ctrl+Enter をもう一度押しても、トークンは1本しか発行しない', async () => {
    let posts = 0;
    const releases: (() => void)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.includes('/access-tokens')) {
        throw new TypeError(`Failed to fetch: ${request.url}`);
      }
      if (request.method === 'POST') {
        posts += 1;
        const id = `t-new-${String(posts)}`;
        await new Promise<void>((resolve) => releases.push(resolve));
        return json({ token: tokenView(id), value: `alt_DUMMY${String(posts)}0123456789` });
      }
      return json({ tokens: [] });
    }) as typeof fetch;

    render(
      <Providers>
        <TestDataRouter>
          <AccessTokens />
        </TestDataRouter>
      </Providers>,
    );

    const name = await screen.findByLabelText(/名前/);
    fireEvent.change(name, { target: { value: 'CI' } });

    fireEvent.keyDown(name, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '発行する' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    fireEvent.keyDown(name, { key: 'Enter', ctrlKey: true });
    fireEvent.submit(name.closest('form') as HTMLFormElement);
    await Promise.resolve();
    await Promise.resolve();

    expect(posts).toBe(1);
    for (const release of releases) release();

    // 応答が返った後は印が解け、もう一度発行できる（止めっぱなしにしない）
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '発行する' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.change(screen.getByLabelText(/名前/), { target: { value: 'CI2' } });
    fireEvent.keyDown(screen.getByLabelText(/名前/), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posts).toBe(2));
    for (const release of releases) release();
  });
});
