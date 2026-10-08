// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storePendingLogin } from '@alteroid/logic';
import { useApiContext } from '@alteroid/swr';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import { useSignIn } from '~/lib/use-sign-in';

const OTHER_BASE_URL = 'http://daemon-2.test';

function Probe() {
  const { setBaseUrl } = useApiContext();
  const { busy, failure, begin } = useSignIn(() => undefined);
  return (
    <div>
      <p data-testid="busy">{busy ? 'busy' : 'idle'}</p>
      <p data-testid="failure">{failure === undefined ? 'none' : 'failed'}</p>
      <button type="button" onClick={() => void begin('google')}>
        begin
      </button>
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

describe('引き取りを待つあいだの接続先の切り替えは、失敗として出さない（#4091）', () => {
  it('ログインを始めて待っている最中に切り替えると、待ちは失敗を出さず静かに畳まれ、記録も消える', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/auth/login')) {
        return json({
          requestId: 'req-1',
          authorizationUrl: 'http://auth.test/start',
          claimSecret: 'shhh',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (url.endsWith('/claim')) return json({ status: 'pending' }, 202);
      return undefined;
    });
    // 本物の fetch と同じく、要求の signal が中断されたら拒否する（世代の中断はここに届く）
    const stubbed = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = input instanceof Request ? input.signal : init?.signal;
      if (signal?.aborted === true) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      return stubbed(input, init);
    }) as typeof fetch;
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'begin' }));
    await waitFor(() => expect(claimsTo(stub.calls, TEST_BASE_URL).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() => expect(screen.getByTestId('busy').textContent).toBe('idle'));
    expect(screen.getByTestId('failure').textContent).toBe('none');
    expect(sessionStorage.getItem('alteroid.pendingLogin')).toBeNull();
    expect(claimsTo(stub.calls, OTHER_BASE_URL)).toEqual([]);
    open.mockRestore();
  });
});
