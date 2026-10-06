// @vitest-environment jsdom
/**
 * ログイン済みで使っている最中の接続確認（`/health`）の再取得が失敗しても、画面を奪わない（issue #3063）。
 *
 * 初回（まだ一度も確認が取れていない）の失敗は従来どおり全体表示（shell.test.tsx が見ている）。
 * ここは「確認済みの後の再検証の失敗」——書きかけの入力欄が unmount で消えないこと、
 * 自動で再試行すること、失敗が続いたときだけ全体表示へ切り替わること。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeCredential, type Credential } from '@alteroid/logic';
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

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: Shell,
        children: [{ index: true, Component: () => <input aria-label="下書き" /> }],
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
/**
 * 入力欄に書きかけを打ち、`/health` を落としてフォーカスで再取得を起こす。
 * `fakeTimers`: RTL の待ちは実時計を要るので、時計を止めるのは入力を済ませた後にする。
 */
async function typeDraftThenFailRecheck(fakeTimers = false): Promise<HTMLInputElement> {
  const input = await screen.findByLabelText<HTMLInputElement>('下書き');
  fireEvent.change(input, { target: { value: '書きかけ' } });
  if (fakeTimers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  healthUp = false;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    if (fakeTimers) await vi.advanceTimersByTimeAsync(50);
  });
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
    expect(screen.queryByText(FULL_SCREEN)).toBeNull();
    // 同じ要素のまま（unmount されていない）で、値も残っている。
    expect(screen.getByLabelText<HTMLInputElement>('下書き')).toBe(input);
    expect(input.value).toBe('書きかけ');
  });

  it('自動で再試行し、直ったら帯が消える（書きかけは残ったまま）', async () => {
    stubFetch(routes);
    renderShell();
    const input = await typeDraftThenFailRecheck(true);
    expect(screen.queryByRole('status')).not.toBeNull();

    healthUp = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(FULL_SCREEN)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('下書き')).toBe(input);
    expect(input.value).toBe('書きかけ');
  });

  it('失敗が続いたときだけ全体表示へ切り替わる', async () => {
    stubFetch(routes);
    renderShell();
    await typeDraftThenFailRecheck(true);
    expect(screen.queryByText(FULL_SCREEN)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });

    expect(screen.queryByText(FULL_SCREEN)).not.toBeNull();
  });

  it('切り替わった後でも、接続が戻れば画面は自動で進む', async () => {
    stubFetch(routes);
    renderShell();
    await typeDraftThenFailRecheck(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(screen.queryByText(FULL_SCREEN)).not.toBeNull();

    healthUp = true;
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }));
    await waitFor(() => {
      expect(screen.queryByText(FULL_SCREEN)).toBeNull();
    });
    expect(screen.queryByLabelText('下書き')).not.toBeNull();
  });
});
