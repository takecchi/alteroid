// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential, type Credential, type PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Approvals from './approvals';

// 許可の承認の「許可」が定型文を送らないと、core は許可を記録しない（#5901）。期待値を定数から作らず逐語で持つ: 定数ごと書き換わっても歯が落ちるため
const permissionApproval: PendingApproval = {
  id: 'a-perm',
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  question: '`git status` を許可してよいか',
  permissionRequest: { rule: 'Bash(git status)', allows: ['git status'], denies: [] },
};
const plainApproval: PendingApproval = {
  id: 'a-plain',
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  question: '本番に出してよいか',
};

const CREDENTIAL: Credential = {
  token: 'alt_perm',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

// account: アカウントで入っている / operator: 持ち主の鍵で入っている / open: 認証無効 / unread: 資格がまだ読めない
type Credentials = 'account' | 'operator' | 'open' | 'unread';

function health(enabled: boolean) {
  return {
    ok: true,
    pid: 1,
    operator: !enabled,
    storage: '/tmp/alteroid',
    auth: { enabled, providers: [] },
  };
}

function stub(approvals: PendingApproval[], credentials: Credentials) {
  const sent: { id: string; answer: unknown }[] = [];
  if (credentials === 'account' || credentials === 'operator') {
    storeCredential(TEST_BASE_URL, CREDENTIAL);
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = input instanceof Request ? input.method : 'GET';
    if (url.pathname === '/health') {
      if (credentials === 'unread') return new Promise<Response>(() => undefined);
      return json(health(credentials !== 'open'));
    }
    if (url.pathname === '/auth/me') {
      return json(
        credentials === 'account'
          ? { kind: 'account', account: CREDENTIAL.account, granted: true }
          : { kind: 'operator' },
      );
    }
    if (url.pathname === '/approvals' && method === 'GET') return json({ approvals });
    const single = /^\/approvals\/([^/]+)\/answer$/.exec(url.pathname);
    if (single && input instanceof Request) {
      const body = (await input.clone().json()) as { answer?: unknown };
      sent.push({ id: decodeURIComponent(single[1]!), answer: body.answer });
      return json({ ok: true });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return sent;
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/approvals', Component: Approvals }], {
    initialEntries: ['/approvals'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const SENDS = '「許可」は「許可します」と送';
const RECORDED = `${SENDS}り、許可（Bash）の一覧に載る。「却下」は「いいえ、やらないで」と送る。`;
const NOT_RECORDED = `${SENDS}る。実行環境の持ち主の鍵で入って答えた許可は、許可（Bash）の一覧に載らない（アカウントで入って答えると載る）。「却下」は「いいえ、やらないで」と送る。`;
const SEND_ONLY = `${SENDS}る。「却下」は「いいえ、やらないで」と送る。`;

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
});

describe('許可の承認の「許可」が送る文（#5901）', () => {
  it.each<Credentials>(['account', 'operator', 'open', 'unread'])(
    'permissionRequest を持つ承認（%s）: 「許可」は「許可します」を送る',
    async (credentials) => {
      const sent = stub([permissionApproval], credentials);
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: '許可' }));
      await waitFor(() => expect(sent).toEqual([{ id: 'a-perm', answer: '許可します' }]));
    },
  );

  it('アカウントで入っている: 補助の文は許可（Bash）の一覧に載ると言う', async () => {
    stub([permissionApproval], 'account');
    renderPage();
    expect(await screen.findByText(RECORDED)).toBeTruthy();
  });

  it('持ち主の鍵で入っている: 補助の文は一覧に載らないと言う', async () => {
    stub([permissionApproval], 'operator');
    renderPage();
    expect(await screen.findByText(NOT_RECORDED)).toBeTruthy();
  });

  it('認証無効（持ち主として答える）: 補助の文は一覧に載らないと言う', async () => {
    stub([permissionApproval], 'open');
    renderPage();
    expect(await screen.findByText(NOT_RECORDED)).toBeTruthy();
  });

  it('資格がまだ読めない間: 載るとも載らないとも言わず、送る文だけを出す', async () => {
    stub([permissionApproval], 'unread');
    renderPage();
    expect(await screen.findByText(SEND_ONLY)).toBeTruthy();
  });

  it('permissionRequest を持つ承認: 「却下」は「いいえ、やらないで」のまま', async () => {
    const sent = stub([permissionApproval], 'account');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '却下' }));
    await waitFor(() => expect(sent).toEqual([{ id: 'a-perm', answer: 'いいえ、やらないで' }]));
  });

  it('permissionRequest を持たない承認: 「許可」は「はい、進めてよい」を送る', async () => {
    const sent = stub([plainApproval], 'account');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '許可' }));
    await waitFor(() => expect(sent).toEqual([{ id: 'a-plain', answer: 'はい、進めてよい' }]));
  });

  it('permissionRequest を持たない承認: 補助の文は許可（Bash）に触れない', async () => {
    stub([plainApproval], 'account');
    renderPage();
    expect(
      await screen.findByText(
        '「許可」は「はい、進めてよい」と送る。「却下」は「いいえ、やらないで」と送る。',
      ),
    ).toBeTruthy();
  });
});
