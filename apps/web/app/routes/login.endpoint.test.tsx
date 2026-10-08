// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storePendingLogin } from '@alteroid/logic';
import { useApiContext } from '@alteroid/swr';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import { useSignIn } from '~/lib/use-sign-in';

const OTHER_BASE_URL = 'http://daemon-2.test';

function Probe() {
  const { setBaseUrl } = useApiContext();
  const { busy } = useSignIn(() => undefined);
  return (
    <div>
      <p data-testid="busy">{busy ? 'busy' : 'idle'}</p>
      <button type="button" onClick={() => setBaseUrl(OTHER_BASE_URL)}>
        switch
      </button>
    </div>
  );
}

function seedPending(baseUrl: string) {
  storePendingLogin({
    requestId: 'req-1',
    claimSecret: 'shhh',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    provider: 'google',
    baseUrl,
  });
}

function claimsTo(calls: string[], base: string) {
  return calls.filter((url) => url.startsWith(base) && url.endsWith('/claim'));
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  sessionStorage.clear();
});

describe('保留中のログインは始めた接続先にだけ送る（#4079）', () => {
  it('引き取りの待ち中に接続先を切り替えても、合鍵は新しい接続先へ送られず、記録も消える', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/claim')) return json({ status: 'pending' }, 202);
      return undefined;
    });
    seedPending(TEST_BASE_URL);
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    await waitFor(() => expect(claimsTo(stub.calls, TEST_BASE_URL).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('idle'));
    expect(sessionStorage.getItem('alteroid.pendingLogin')).toBeNull();
    expect(claimsTo(stub.calls, OTHER_BASE_URL)).toEqual([]);
  });

  it('別の接続先で始めた記録が残っていても、読み直した先へ合鍵を送らない', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/claim')) return json({ status: 'pending' }, 202);
      return undefined;
    });
    seedPending(OTHER_BASE_URL);
    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(sessionStorage.getItem('alteroid.pendingLogin')).toBeNull());
    expect(screen.getByTestId('busy').textContent).toBe('idle');
    expect(stub.calls.filter((url) => url.endsWith('/claim'))).toEqual([]);
  });
});
