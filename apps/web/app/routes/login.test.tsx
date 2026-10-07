// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential } from '@alteroid/logic';
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
  globalThis.fetch = originalFetch;
  window.history.pushState({}, '', '/');
});

function renderUngranted() {
  const stub = stubFetch((url) => {
    if (url.endsWith('/health')) return json(HEALTH);
    if (url.endsWith('/auth/me')) return json({ error: '使う許可が無い' }, 403);
    return undefined;
  });
  render(
    <Providers>
      <Login />
    </Providers>,
  );
  return stub;
}

// 実在の window.location も同じ経路に合わせる: MemoryRouter は window.location に触らず、そちらだけを見る将来のコードを initialEntries だけでは捕まえられないため
function renderSignIn(initialEntry = '/login') {
  // 鍵を消す: credential === null でないと use-auth は /auth/me を叩きにいって ungranted / ready 側へ落ちるため
  localStorage.clear();
  storeTestBaseUrl();
  stubFetch((url) => {
    if (url.endsWith('/health')) return json(HEALTH);
    return undefined;
  });
  window.history.pushState({}, '', initialEntry);
  const router = createMemoryRouter([{ path: '/login', Component: Login }], {
    initialEntries: [initialEntry],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('ログイン画面のどの分岐からでも接続先を変えられる（PR 1）', () => {
  it('SignIn（未ログイン）でも接続先の入力欄が出る', async () => {
    renderSignIn();
    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
    expect(await screen.findByText(TEST_BASE_URL, { selector: 'span' })).toBeTruthy();
  });

  it('Ungranted（使う許可待ち）でも接続先の入力欄が出る', async () => {
    renderUngranted();
    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
  });

  it('繋がらない分岐で、接続先の入力欄は1つだけ（二重に出さない）', async () => {
    localStorage.clear();
    storeTestBaseUrl();
    stubFetch(() => undefined);
    render(
      <Providers>
        <Login />
      </Providers>,
    );
    expect(await screen.findByText('接続先のサーバに繋がらない')).toBeTruthy();
    expect(screen.getAllByLabelText('接続先')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '既定に戻す' })).toHaveLength(1);
  });
});

describe('Ungranted の「別のアカウントでログイン」（issue #1757）', () => {
  function renderUngrantedInRouter(logout: () => Response) {
    const stub = stubFetch((url) => {
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/auth/me')) return json({ error: '使う許可が無い' }, 403);
      if (url.endsWith('/auth/logout')) return logout();
      return undefined;
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

  it('サーバ側で失効させてから鍵を捨てる', async () => {
    const stub = renderUngrantedInRouter(() => json({ ok: true }));
    const button = await screen.findByRole('button', { name: '別のアカウントでログイン' });

    button.click();

    await screen.findByLabelText('接続先');
    expect(stub.calls.some((url) => url.endsWith('/auth/logout'))).toBe(true);
    expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
  });

  it('失効に失敗したら鍵を残してその旨を出し、鍵だけを捨てる操作で捨てられる', async () => {
    renderUngrantedInRouter(() => json({ error: '落ちた' }, 500));
    const button = await screen.findByRole('button', { name: '別のアカウントでログイン' });

    button.click();

    await screen.findByText(/サーバ側を失効させられなかった/);
    expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).not.toBeNull();

    screen.getByRole('button', { name: 'この画面から鍵だけを捨てる' }).click();

    await screen.findByLabelText('接続先');
    expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
  });
});

// 接続先をクエリ文字列・ハッシュなど外から渡せる経路から受け取らない: 外から指定できると、リンクを開いた人が攻撃者のサーバへ資格情報を打ち込む経路になるため
describe('URL のクエリ文字列・ハッシュから接続先を受け取らない（本(4)/歯5）', () => {
  const MALICIOUS = 'https://evil.example.com';

  it('クエリ文字列に URL を積んでも、表示される接続先も保存先も変わらない', async () => {
    renderSignIn(
      `/login?apiBaseUrl=${encodeURIComponent(MALICIOUS)}&baseUrl=${encodeURIComponent(MALICIOUS)}`,
    );

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
    expect(input.value).not.toBe(MALICIOUS);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);
  });

  it('ハッシュに URL を積んでも、表示される接続先も保存先も変わらない', async () => {
    renderSignIn(`/login#apiBaseUrl=${encodeURIComponent(MALICIOUS)}`);

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);
    expect(input.value).not.toBe(MALICIOUS);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);
  });

  it('クエリ文字列に積んだ値のまま「適用」しても、保存されるのは入力欄に打った値だけ', async () => {
    renderSignIn(`/login?apiBaseUrl=${encodeURIComponent(MALICIOUS)}`);

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).not.toBe(MALICIOUS);
  });
});

describe('横並びの積み替え（本4-A）: アカウント情報の dl', () => {
  it('狭い画面では1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderUngranted();

    const anchor = await screen.findByText('アカウント');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    expect(dlTokens).toContain('grid-cols-1');
    expect(dl!.style.getPropertyValue('--kv-label')).toBe('5rem');
    const smCols = dlTokens.filter((token) => token.startsWith('sm:grid-cols-'));
    expect(smCols).toHaveLength(1);
    expect(smCols[0]).toContain('var(--kv-label)');
    expect(dlTokens.filter((token) => /^grid-cols-/.test(token))).toEqual(['grid-cols-1']);
  });

  it('先頭以外の dt に上の余白と sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    renderUngranted();

    const anchor = await screen.findByText('アカウント');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dts = Array.from(dl!.querySelectorAll('dt'));
    expect(dts.length).toBeGreaterThan(1);
    const first = dts[0]!.className.split(/\s+/);
    expect(first).not.toContain('mt-3');
    expect(first).not.toContain('sm:mt-0');
    for (const dt of dts.slice(1)) {
      const tokens = dt.className.split(/\s+/);
      expect(tokens).toContain('mt-3');
      expect(tokens).toContain('sm:mt-0');
    }
  });
});

describe('コンソールから手で設定した接続先が、描画しただけで消えない', () => {
  const CONSOLE_SET_URL = 'http://console-set.example';

  it('(a)(b)(c) を1本で確かめる', async () => {
    localStorage.clear();
    localStorage.setItem('alteroid.apiBaseUrl', CONSOLE_SET_URL);

    const stub = stubFetch((url) => {
      if (url.startsWith(CONSOLE_SET_URL) && url.endsWith('/health')) return json(HEALTH);
      return undefined;
    });

    const router = createMemoryRouter([{ path: '/login', Component: Login }], {
      initialEntries: ['/login'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(stub.calls.some((url) => url.startsWith(CONSOLE_SET_URL))).toBe(true);

    expect(input.value).toBe(CONSOLE_SET_URL);

    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(CONSOLE_SET_URL);
  });
});

describe('再検証の一過性の失敗でも、前回の画面を残して再試行の口を足す（#3379）', () => {
  function renderUngrantedFlaky() {
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
    return {
      setFailing: (value: boolean) => {
        failing = value;
      },
    };
  }

  it('「許可されたか確認する」の確認が失敗しても、アカウントとコマンドの画面は残り、再試行で戻る', async () => {
    const flaky = renderUngrantedFlaky();
    expect(await screen.findByText('まだ使う許可が無い')).toBeTruthy();

    flaky.setFailing(true);
    fireEvent.click(screen.getByRole('button', { name: '許可されたか確認する' }));

    const retry = await screen.findByRole('button', { name: /もう一度試す/ });
    expect(screen.getByText('まだ使う許可が無い')).toBeTruthy();
    expect(screen.getByDisplayValue('alteroid access grant acc-1')).toBeTruthy();
    expect(screen.getByText('acc-1')).toBeTruthy();
    expect(screen.queryByText('接続先のサーバに繋がらない')).toBeNull();

    flaky.setFailing(false);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: /もう一度試す/ })).toBeNull());
    expect(screen.getByText('まだ使う許可が無い')).toBeTruthy();
  });

  it('初回から読めないときは、今までどおりエラーの画面（再試行の口つき）にする', async () => {
    localStorage.clear();
    storeTestBaseUrl();
    stubFetch(() => undefined);
    render(
      <Providers>
        <Login />
      </Providers>,
    );
    expect(await screen.findByText('接続先のサーバに繋がらない')).toBeTruthy();
    expect(screen.getByRole('button', { name: /もう一度試す/ })).toBeTruthy();
    expect(screen.queryByText('まだ使う許可が無い')).toBeNull();
  });
});
