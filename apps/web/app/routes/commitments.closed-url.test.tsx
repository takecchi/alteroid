// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Commitments from './commitments';

const AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

function stubCommitments() {
  return stubFetch((url) => {
    if (!url.includes('/commitments')) return undefined;
    const open = {
      id: 'open-1',
      origin: 'human',
      body: 'まだ終わっていない',
      at: AT,
      updatedAt: AT,
    };
    const closed = {
      id: 'closed-1',
      origin: 'human',
      body: 'もう終わった',
      at: AT,
      updatedAt: AT,
      closedAt: AT,
      closedReason: 'マージした',
    };
    return json({ entries: url.includes('includeClosed=true') ? [open, closed] : [open] });
  });
}

function renderAt(entry: string) {
  const router = createMemoryRouter(
    [
      { path: '/commitments', Component: Commitments },
      { path: '/elsewhere', Component: () => <p>別の画面</p> },
    ],
    { initialEntries: [entry] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

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

describe('台帳の「片付けたものも見る」を URL に持つ（#4016）', () => {
  it('押すと ?closed=1 が付き、別の画面へ移って戻っても片付けたものが出たままになる', async () => {
    stubCommitments();
    const router = renderAt('/commitments');
    await screen.findByText('まだ終わっていない');

    fireEvent.click(screen.getByRole('button', { name: '片付けたものも見る' }));
    expect(await screen.findByText('もう終わった')).toBeTruthy();
    expect(router.state.location.search).toBe('?closed=1');

    await router.navigate('/elsewhere');
    await screen.findByText('別の画面');
    await router.navigate(-1);

    expect(await screen.findByText('もう終わった')).toBeTruthy();
    expect(screen.getByRole('button', { name: '未了だけ' })).toBeTruthy();
  });

  it('?closed=1 で開き直す（再読み込み・URL の共有）と、片付けたものが出る', async () => {
    stubCommitments();
    renderAt('/commitments?closed=1');
    expect(await screen.findByText('もう終わった')).toBeTruthy();
  });

  it('「未了だけ」で戻すと ?closed が消え、履歴は増えない', async () => {
    stubCommitments();
    const router = renderAt('/commitments?closed=1');
    await screen.findByText('もう終わった');

    fireEvent.click(screen.getByRole('button', { name: '未了だけ' }));
    await screen.findByRole('button', { name: '片付けたものも見る' });

    expect(router.state.location.search).toBe('');
    expect(screen.queryByText('もう終わった')).toBeNull();
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('知らない値は黙って読み替えず、注記を出して未了だけで表示する', async () => {
    stubCommitments();
    renderAt('/commitments?closed=yes');
    await screen.findByText('まだ終わっていない');
    expect(
      screen.getByText(/指定された値（yes）は読めないので、未了だけで表示しています/),
    ).toBeTruthy();
    expect(screen.queryByText('もう終わった')).toBeNull();
  });

  it('重複は先頭の値を使うと言う', async () => {
    stubCommitments();
    renderAt('/commitments?closed=1&closed=0');
    expect(await screen.findByText('もう終わった')).toBeTruthy();
    expect(screen.getByText(/指定が複数あるので、先頭の値を使っています/)).toBeTruthy();
  });
});
