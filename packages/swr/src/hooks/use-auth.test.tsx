// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAuth } from './use-auth';
import { useApiContext } from '../api';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '../test-support';
import type { Credential } from '@alteroid/logic';

const CREDENTIAL: Credential = {
  token: 'alt_expired',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

const CREDENTIAL_KEY = `alteroid.credential:${TEST_BASE_URL}`;

const HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

function Probe() {
  const auth = useAuth();
  return <div data-testid="status">{auth.status}</div>;
}

function renderProbe() {
  return render(
    <Providers>
      <Probe />
    </Providers>,
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(CREDENTIAL));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('保存済みの鍵が失効していたとき（/auth/me が 401）', () => {
  it('未ログインへ戻り、鍵を保存先から捨て、以降は資格情報を付けない', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) return json({ error: 'トークンが無効か期限切れ' }, 401);
      return undefined;
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('anonymous');
    });

    await waitFor(() => {
      expect(localStorage.getItem(CREDENTIAL_KEY)).toBeNull();
    });

    await waitFor(() => {
      const later = stub.entries.filter((entry) => entry.url.endsWith('/health')).at(-1);
      expect(later?.authorization).toBeNull();
    });
    expect(stub.entries[0]?.authorization).toBe('Bearer alt_expired');

    expect(stub.entries.filter((entry) => entry.url.endsWith('/auth/me'))).toHaveLength(1);
  });
});

describe('許可が無いとき（/auth/me が 403）', () => {
  it('鍵は捨てない（やり直しても解決しないログインへ戻さない）', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) return json({ error: '使う許可が無い' }, 403);
      return undefined;
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('ungranted');
    });
    expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();
  });
});

describe('認証を要求していないデーモン', () => {
  it('鍵の有無に関わらず open になる', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) {
        return json({ ...HEALTH, operator: true, auth: { enabled: false, providers: [] } });
      }
      return undefined;
    });

    renderProbe();

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('open');
    });
    expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();
  });
});

describe('接続先を切り替えた後に、古い相手の 401 が届いたとき', () => {
  const OTHER = 'http://other.test';
  const OTHER_KEY = `alteroid.credential:${OTHER}`;
  const OTHER_CREDENTIAL: Credential = {
    token: 'alt_other_valid',
    account: { id: 'acc-2', displayName: null, email: 'other@example.com' },
    grantedAtClaim: true,
    createdAt: '2026-08-13T00:00:00.000Z',
  };

  function Switcher() {
    const auth = useAuth();
    const { baseUrl, setBaseUrl } = useApiContext();
    return (
      <div>
        <div data-testid="status">{auth.status}</div>
        <div data-testid="base">{baseUrl}</div>
        <button type="button" onClick={() => setBaseUrl(OTHER)}>
          切り替える
        </button>
      </div>
    );
  }

  it('切り替えた先の鍵と認証状態を保つ', async () => {
    localStorage.setItem(OTHER_KEY, JSON.stringify(OTHER_CREDENTIAL));

    let answerOld: ((response: Response) => void) | undefined;
    const oldMe = new Promise<Response>((resolve) => {
      answerOld = resolve;
    });

    const stub = stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.startsWith(TEST_BASE_URL) && url.endsWith('/auth/me')) return oldMe;
      if (url.startsWith(OTHER) && url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: OTHER_CREDENTIAL.account, granted: true });
      }
      return undefined;
    });

    render(
      <Providers>
        <Switcher />
      </Providers>,
    );

    await waitFor(() => {
      expect(stub.calls.some((url) => url === `${TEST_BASE_URL}/auth/me`)).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));

    await waitFor(() => {
      expect(screen.getByTestId('base').textContent).toBe(OTHER);
      expect(screen.getByTestId('status').textContent).toBe('ready');
    });

    answerOld?.(json({ error: 'トークンが無効か期限切れ' }, 401));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(localStorage.getItem(OTHER_KEY)).not.toBeNull();
    expect(localStorage.getItem(CREDENTIAL_KEY)).toBeNull();

    const last = stub.entries.filter((entry) => entry.url.startsWith(OTHER)).at(-1);
    expect(last?.authorization).toBe(`Bearer ${OTHER_CREDENTIAL.token}`);
  });
});

describe('logout（issue #1757）', () => {
  function LogoutProbe() {
    const auth = useAuth();
    const [result, setResult] = useState('idle');
    return (
      <div>
        <div data-testid="status">{auth.status}</div>
        <div data-testid="result">{result}</div>
        <button
          type="button"
          onClick={() => {
            void auth.logout().then((r) => setResult(r.ok ? 'ok' : `error:${r.message}`));
          }}
        >
          logout
        </button>
        <button type="button" onClick={() => auth.discardCredential()}>
          discard
        </button>
      </div>
    );
  }

  function renderLogoutProbe() {
    return render(
      <Providers>
        <LogoutProbe />
      </Providers>,
    );
  }

  it('成功（200）→ POST /auth/logout を1回呼び、鍵を捨てる', async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      if (url.endsWith('/auth/logout')) return json({ ok: true });
      return undefined;
    });
    renderLogoutProbe();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));

    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('ok'));
    expect(localStorage.getItem(CREDENTIAL_KEY)).toBeNull();
    const logoutCalls = stub.entries.filter((entry) => entry.url.endsWith('/auth/logout'));
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0]?.authorization).toBe(`Bearer ${CREDENTIAL.token}`);
  });

  it('401（既に無効）→ 成功と同じく鍵を捨てる', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      if (url.endsWith('/auth/logout')) {
        return json({ error: 'トークンが無効か期限切れ' }, 401);
      }
      return undefined;
    });
    renderLogoutProbe();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));

    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('ok'));
    expect(localStorage.getItem(CREDENTIAL_KEY)).toBeNull();
  });

  it('失敗（500）→ 鍵は残す。discardCredential() で鍵だけを別途捨てられる', async () => {
    stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) {
        return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
      }
      if (url.endsWith('/auth/logout')) return json({ error: 'internal' }, 500);
      return undefined;
    });
    renderLogoutProbe();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));

    await waitFor(() => {
      expect(screen.getByTestId('result').textContent?.startsWith('error:')).toBe(true);
    });
    expect(localStorage.getItem(CREDENTIAL_KEY)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'discard' }));
    await waitFor(() => expect(localStorage.getItem(CREDENTIAL_KEY)).toBeNull());
  });

  it('鍵が無ければサーバへは呼ばず、ok を返す', async () => {
    localStorage.clear();
    storeTestBaseUrl();
    const stub = stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      return undefined;
    });
    renderLogoutProbe();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));

    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('ok'));
    expect(stub.calls.some((url) => url.endsWith('/auth/logout'))).toBe(false);
  });
});
