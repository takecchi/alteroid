// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeCredential, type Credential } from '@alteroid/logic';
import { useAuth } from '@alteroid/swr';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Shell from './shell';

const AUTH_HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

const CREDENTIAL: Credential = {
  token: 'alt_recheck',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

const FULL_SCREEN = '接続先のサーバに繋がらない';
// useAuth を Shell とは別のインスタンスで使う: 再検証をどのインスタンスが始めるかは購読順で決まり、判断をインスタンスごとの state に置くと実アプリでだけ破れるため
function Draft() {
  useAuth();
  return <input aria-label="下書き" />;
}

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [{ index: true, Component: Draft }],
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
let healthUp: boolean;

function routes(url: string): Response | undefined {
  if (url.endsWith('/health')) return healthUp ? json(AUTH_HEALTH) : undefined;
  if (url.endsWith('/auth/me')) {
    return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
  }
  return undefined;
}
// 小刻みに進めて実時計側で結果を取り込ませる: fetch の失敗は実の非同期で返るため
async function advance(ms: number): Promise<void> {
  for (let left = ms, first = true; first || left > 0; left -= 2_500, first = false) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(2_500, left));
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    });
  }
}

// 時計を止めるのは入力を済ませた後にする: RTL の待ちは実時計を要するため
async function typeDraftThenFailRecheck(fakeTimers = false): Promise<HTMLInputElement> {
  const input = await screen.findByLabelText<HTMLInputElement>('下書き');
  fireEvent.change(input, { target: { value: '書きかけ' } });
  if (fakeTimers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  healthUp = false;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  if (fakeTimers) {
    for (let i = 0; i < 200 && screen.queryByRole('status') === null; i++) await advance(0);
  }
  return input;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  storeCredential(TEST_BASE_URL, CREDENTIAL);
  healthUp = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('確認済みの後の再検証の失敗（issue #3063）', () => {
  it('1回失敗しても画面は置き換わらず、書きかけが残る。上に小さく知らせる', async () => {
    stubFetch(routes);
    renderShell();

    const input = await typeDraftThenFailRecheck();

    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: FULL_SCREEN })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('下書き')).toBe(input);
    expect(input.value).toBe('書きかけ');
  }, 30_000);

  it('自動で再試行し、直ったら帯が消える（書きかけは残ったまま）', async () => {
    stubFetch(routes);
    renderShell();
    const input = await typeDraftThenFailRecheck(true);
    expect(screen.queryByRole('status')).not.toBeNull();

    healthUp = true;
    await advance(10_000);

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('heading', { name: FULL_SCREEN })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('下書き')).toBe(input);
    expect(input.value).toBe('書きかけ');
  }, 30_000);

  it('失敗が続いたときだけ全体表示へ切り替わる', async () => {
    stubFetch(routes);
    renderShell();
    await typeDraftThenFailRecheck(true);
    expect(screen.queryByRole('heading', { name: FULL_SCREEN })).toBeNull();

    await advance(180_000);

    expect(screen.queryByRole('heading', { name: FULL_SCREEN })).not.toBeNull();
  }, 30_000);

  it('切り替わった後でも、接続が戻れば画面は自動で進む', async () => {
    stubFetch(routes);
    renderShell();
    await typeDraftThenFailRecheck(true);
    await advance(180_000);
    expect(screen.queryByRole('heading', { name: FULL_SCREEN })).not.toBeNull();

    healthUp = true;
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: FULL_SCREEN })).toBeNull();
    });
    expect(await screen.findByLabelText('下書き')).toBeTruthy();
  }, 30_000);
});
